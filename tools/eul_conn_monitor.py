#!/usr/bin/env python3
"""
EUL Verbindungs-Monitor (GUI)

Ueberwacht die TCP-Verbindung zum EUL-Gateway so, wie Home Assistant sie
nutzt: das Tool baut selbst eine Dauerverbindung zum ESP3-TCP-Port auf und
protokolliert jeden Abbruch und Wiederaufbau mit Zeitstempel und Dauer. So
sieht man zuverlaessig, OB und WANN die Verbindung abreisst (z.B. durch das
FritzBox-Mesh) - unabhaengig davon, ob das HTTP-Portal gerade erreichbar ist.

Start:  python eul_conn_monitor.py
Nur Standardbibliothek (tkinter), keine Installation noetig.
"""
import socket
import threading
import queue
import time
import tkinter as tk
from tkinter import ttk, filedialog, messagebox
from datetime import datetime

DEFAULT_HOST = "eul.local"
DEFAULT_PORT = 2325            # ESP3-TCP-Port des EUL (siehe Portal -> EnOcean)
CONNECT_TIMEOUT = 5.0
RETRY_INTERVAL = 2.0
DOWN_REMINDER = 15.0           # waehrend Ausfall alle 15s eine Erinnerung loggen


def enable_keepalive(sock):
    """OS-Keepalive aggressiv setzen, damit ein stiller Link-Abriss erkannt wird."""
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
        if hasattr(socket, "SIO_KEEPALIVE_VALS"):          # Windows
            sock.ioctl(socket.SIO_KEEPALIVE_VALS, (1, 5000, 1000))
        else:                                              # Linux/macOS
            for opt, val in (("TCP_KEEPIDLE", 5), ("TCP_KEEPINTVL", 2), ("TCP_KEEPCNT", 4)):
                if hasattr(socket, opt):
                    sock.setsockopt(socket.IPPROTO_TCP, getattr(socket, opt), val)
    except OSError:
        pass


def describe(err):
    if isinstance(err, socket.timeout):
        return "Zeitueberschreitung"
    msg = str(err)
    low = msg.lower()
    if "refused" in low:
        return "abgelehnt (Server aus / Port zu)"
    if "unreachable" in low or "erreichbar" in low or "10065" in low or "113" in low:
        return "Host nicht erreichbar (L2/Netz)"
    if "timed out" in low or "10060" in low:
        return "Zeitueberschreitung (unerreichbar)"
    if "reset" in low or "10054" in low:
        return "Verbindung zurueckgesetzt (RST)"
    return msg


def do_optional_auth(sock, token, log):
    """Falls der Server einen AUTH-Banner sendet, mit Token antworten.
    Bei auth=off sendet der EUL nichts -> kurzes Timeout, dann normal weiter."""
    sock.settimeout(0.8)
    try:
        data = sock.recv(64)
    except socket.timeout:
        return True            # kein Banner -> auth aus, alles gut
    except OSError:
        raise
    if data.startswith(b"HELLO") and b"AUTH-REQUIRED" in data:
        if not token:
            log("Server verlangt AUTH-Token, aber keiner eingetragen!")
            return False
        sock.sendall(("AUTH %s\n" % token).encode())
        try:
            resp = sock.recv(16)
        except OSError as e:
            log("AUTH fehlgeschlagen: %s" % describe(e))
            return False
        if not resp.startswith(b"OK"):
            log("AUTH abgelehnt (falscher Token?)")
            return False
        log("AUTH erfolgreich")
    return True


class Monitor:
    def __init__(self, host, port, token, q):
        self.host, self.port, self.token, self.q = host, port, token, q
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self.run, daemon=True)

    def start(self):
        self.thread.start()

    def _emit(self, kind, **kw):
        kw["kind"] = kind
        kw["t"] = time.time()
        self.q.put(kw)

    def run(self):
        down_since = time.monotonic()   # gilt als "vor dem ersten Connect unten"
        first = True
        last_reminder = 0.0
        while not self.stop.is_set():
            t0 = time.monotonic()
            try:
                sock = socket.create_connection((self.host, self.port), timeout=CONNECT_TIMEOUT)
            except OSError as e:
                now = time.monotonic()
                if first or (now - last_reminder) >= DOWN_REMINDER:
                    self._emit("down", reason=describe(e),
                               downtime=now - down_since, first=first)
                    last_reminder = now
                    first = False
                self.stop.wait(RETRY_INTERVAL)
                continue

            enable_keepalive(sock)
            try:
                ok = do_optional_auth(sock, self.token, lambda m: self._emit("log", msg=m))
            except OSError as e:
                sock.close()
                self._emit("down", reason="Setup: " + describe(e),
                           downtime=time.monotonic() - down_since, first=False)
                self.stop.wait(RETRY_INTERVAL)
                continue
            if not ok:
                sock.close()
                self.stop.wait(RETRY_INTERVAL)
                continue

            downtime = time.monotonic() - down_since
            self._emit("up", connect_ms=(time.monotonic() - t0) * 1000.0, downtime=downtime)
            up_since = time.monotonic()

            # Lese-Schleife: empfangene Daten verwerfen; recv==0 oder Fehler = Abbruch.
            sock.settimeout(1.0)
            rx = 0
            while not self.stop.is_set():
                try:
                    data = sock.recv(2048)
                    if data == b"":
                        reason = "Gegenstelle geschlossen (FIN)"
                        break
                    rx += len(data)
                except socket.timeout:
                    continue
                except OSError as e:
                    reason = describe(e)
                    break
            else:
                reason = "Monitor gestoppt"

            try:
                sock.close()
            except OSError:
                pass
            down_since = time.monotonic()
            last_reminder = down_since
            first = False
            if not self.stop.is_set():
                self._emit("lost", reason=reason, uptime=down_since - up_since, rx=rx)
        self._emit("stopped")


class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("EUL Verbindungs-Monitor")
        self.geometry("760x560")
        self.minsize(620, 460)
        self.q = queue.Queue()
        self.monitor = None

        # Statistik
        self.reset_stats()

        self._build_ui()
        self.after(150, self._poll)

    def reset_stats(self):
        self.connects = 0
        self.drops = 0
        self.total_up = 0.0
        self.total_down = 0.0
        self.longest_down = 0.0
        self.session_start = None
        self.state = "idle"
        self.state_since = time.monotonic()

    # ---------- UI ----------
    def _build_ui(self):
        pad = dict(padx=6, pady=4)
        top = ttk.Frame(self)
        top.pack(fill="x", **pad)
        ttk.Label(top, text="Host:").grid(row=0, column=0, sticky="e")
        self.e_host = ttk.Entry(top, width=22)
        self.e_host.insert(0, DEFAULT_HOST)
        self.e_host.grid(row=0, column=1, padx=4)
        ttk.Label(top, text="Port:").grid(row=0, column=2, sticky="e")
        self.e_port = ttk.Entry(top, width=7)
        self.e_port.insert(0, str(DEFAULT_PORT))
        self.e_port.grid(row=0, column=3, padx=4)
        ttk.Label(top, text="Token (optional):").grid(row=0, column=4, sticky="e")
        self.e_token = ttk.Entry(top, width=16, show="*")
        self.e_token.grid(row=0, column=5, padx=4)
        self.btn_start = ttk.Button(top, text="Start", command=self.on_start)
        self.btn_start.grid(row=0, column=6, padx=6)
        self.btn_stop = ttk.Button(top, text="Stop", command=self.on_stop, state="disabled")
        self.btn_stop.grid(row=0, column=7)

        # Status-Banner
        self.banner = tk.Label(self, text="BEREIT", font=("Segoe UI", 20, "bold"),
                               bg="#888", fg="white", pady=10)
        self.banner.pack(fill="x", padx=6, pady=(2, 6))

        # Statistik-Raster
        stat = ttk.LabelFrame(self, text="Statistik")
        stat.pack(fill="x", padx=6, pady=2)
        self.lbl = {}
        cells = [
            ("state_since", "Status seit"),
            ("connects", "Verbindungen"),
            ("drops", "Abbrueche"),
            ("avail", "Verfuegbarkeit"),
            ("down_total", "Ausfall gesamt"),
            ("down_longest", "Laengster Ausfall"),
        ]
        for i, (key, title) in enumerate(cells):
            f = ttk.Frame(stat)
            f.grid(row=i // 3, column=i % 3, sticky="w", padx=10, pady=3)
            ttk.Label(f, text=title + ":", foreground="#666").pack(anchor="w")
            v = ttk.Label(f, text="-", font=("Segoe UI", 11, "bold"))
            v.pack(anchor="w")
            self.lbl[key] = v

        # Log
        logf = ttk.LabelFrame(self, text="Ereignis-Protokoll")
        logf.pack(fill="both", expand=True, padx=6, pady=4)
        self.log = tk.Text(logf, height=12, wrap="none", font=("Consolas", 10))
        self.log.pack(side="left", fill="both", expand=True)
        sb = ttk.Scrollbar(logf, command=self.log.yview)
        sb.pack(side="right", fill="y")
        self.log.config(yscrollcommand=sb.set, state="disabled")
        self.log.tag_config("up", foreground="#127a12")
        self.log.tag_config("down", foreground="#b00000")
        self.log.tag_config("info", foreground="#555")

        bottom = ttk.Frame(self)
        bottom.pack(fill="x", padx=6, pady=(0, 6))
        ttk.Button(bottom, text="Log speichern...", command=self.save_log).pack(side="left")
        ttk.Button(bottom, text="Leeren", command=self.clear_log).pack(side="left", padx=6)

    # ---------- Aktionen ----------
    def on_start(self):
        host = self.e_host.get().strip()
        try:
            port = int(self.e_port.get().strip())
        except ValueError:
            messagebox.showerror("Fehler", "Port muss eine Zahl sein.")
            return
        token = self.e_token.get().strip()
        self.reset_stats()
        self.session_start = time.monotonic()
        self.monitor = Monitor(host, port, token, self.q)
        self.monitor.start()
        self.btn_start.config(state="disabled")
        self.btn_stop.config(state="normal")
        for w in (self.e_host, self.e_port, self.e_token):
            w.config(state="disabled")
        self._set_state("verbindet", "#c07000")
        self._log("Monitor gestartet -> %s:%d" % (host, port), "info")

    def on_stop(self):
        if self.monitor:
            self.monitor.stop.set()
        self.btn_stop.config(state="disabled")

    # ---------- Queue / Update ----------
    def _poll(self):
        try:
            while True:
                ev = self.q.get_nowait()
                self._handle(ev)
        except queue.Empty:
            pass
        self._refresh_stats()
        self.after(200, self._poll)

    def _handle(self, ev):
        kind = ev["kind"]
        ts = datetime.fromtimestamp(ev["t"]).strftime("%H:%M:%S")
        if kind == "up":
            self.connects += 1
            self._set_state("VERBUNDEN", "#127a12")
            dt = ev.get("downtime", 0.0)
            extra = ("  (Ausfall war %s)" % fmt_dur(dt)) if self.connects > 1 and dt > 0 else ""
            self._log("[%s] VERBUNDEN  (Aufbau %.0f ms)%s" %
                      (ts, ev.get("connect_ms", 0), extra), "up")
        elif kind == "lost":
            self.drops += 1
            self._set_state("GETRENNT", "#b00000")
            self._log("[%s] ABBRUCH: %s  (war %s verbunden, %d B empfangen)" %
                      (ts, ev.get("reason", "?"), fmt_dur(ev.get("uptime", 0)),
                       ev.get("rx", 0)), "down")
        elif kind == "down":
            self._set_state("UNERREICHBAR", "#b00000")
            if ev.get("first"):
                self._log("[%s] nicht erreichbar: %s" % (ts, ev.get("reason", "?")), "down")
            else:
                self._log("[%s] weiter unerreichbar (%s): %s" %
                          (ts, fmt_dur(ev.get("downtime", 0)), ev.get("reason", "?")), "down")
        elif kind == "log":
            self._log("[%s] %s" % (ts, ev.get("msg", "")), "info")
        elif kind == "stopped":
            self._set_state("GESTOPPT", "#888")
            self._log("[%s] Monitor gestoppt." % ts, "info")
            self.btn_start.config(state="normal")
            self.btn_stop.config(state="disabled")
            for w in (self.e_host, self.e_port, self.e_token):
                w.config(state="normal")
            self.monitor = None

    def _set_state(self, text, color):
        # Zeit der vorherigen Phase auf die Summen buchen
        now = time.monotonic()
        dur = now - self.state_since
        if self.state == "VERBUNDEN":
            self.total_up += dur
        elif self.state in ("GETRENNT", "UNERREICHBAR"):
            self.total_down += dur
            self.longest_down = max(self.longest_down, dur)
        self.state = text
        self.state_since = now
        self.banner.config(text=text, bg=color)

    def _refresh_stats(self):
        now = time.monotonic()
        # aktuelle Phase live dazurechnen fuer Anzeige
        cur = now - self.state_since
        up = self.total_up + (cur if self.state == "VERBUNDEN" else 0)
        down = self.total_down + (cur if self.state in ("GETRENNT", "UNERREICHBAR") else 0)
        longest = max(self.longest_down, cur if self.state in ("GETRENNT", "UNERREICHBAR") else 0)
        total = up + down
        self.lbl["state_since"].config(text=fmt_dur(cur))
        self.lbl["connects"].config(text=str(self.connects))
        self.lbl["drops"].config(text=str(self.drops))
        self.lbl["avail"].config(text=("%.1f %%" % (100.0 * up / total)) if total > 0 else "-")
        self.lbl["down_total"].config(text=fmt_dur(down))
        self.lbl["down_longest"].config(text=fmt_dur(longest))

    def _log(self, text, tag="info"):
        self.log.config(state="normal")
        self.log.insert("end", text + "\n", tag)
        self.log.see("end")
        self.log.config(state="disabled")

    def save_log(self):
        path = filedialog.asksaveasfilename(defaultextension=".txt",
                                            initialfile="eul_monitor_%s.txt" %
                                            datetime.now().strftime("%Y%m%d_%H%M%S"),
                                            filetypes=[("Text", "*.txt")])
        if path:
            with open(path, "w", encoding="utf-8") as f:
                f.write(self.log.get("1.0", "end"))

    def clear_log(self):
        self.log.config(state="normal")
        self.log.delete("1.0", "end")
        self.log.config(state="disabled")


def fmt_dur(sec):
    sec = int(sec)
    if sec < 60:
        return "%ds" % sec
    if sec < 3600:
        return "%dm %02ds" % (sec // 60, sec % 60)
    return "%dh %02dm" % (sec // 3600, (sec % 3600) // 60)


if __name__ == "__main__":
    App().mainloop()
