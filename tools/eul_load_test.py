#!/usr/bin/env python3
"""
EUL Verbindungs-/Lasttest (GUI)

Oeffnet gleichzeitig eine einstellbare Anzahl X an TCP-Verbindungen zum
EUL-Gateway und zeigt pro Verbindung den Status. Damit laesst sich das
Verhalten des TCP-Servers testen - z.B. das Client-Limit (EUL_MAX_CLIENTS,
Werkseinstellung 4): mehr Verbindungen als erlaubt werden abgewiesen oder
wieder geschlossen.

Start:  python eul_load_test.py
Nur Standardbibliothek (tkinter), keine Installation noetig.
"""
import socket
import threading
import queue
import time
import tkinter as tk
from tkinter import ttk, messagebox
from datetime import datetime

DEFAULT_HOST = "eul.local"
DEFAULT_PORT = 2325
CONNECT_TIMEOUT = 5.0


def enable_keepalive(sock):
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
        if hasattr(socket, "SIO_KEEPALIVE_VALS"):
            sock.ioctl(socket.SIO_KEEPALIVE_VALS, (1, 5000, 1000))
    except OSError:
        pass


def describe(err):
    if isinstance(err, socket.timeout):
        return "Zeitueberschreitung"
    low = str(err).lower()
    if "refused" in low:
        return "abgelehnt (kein freier Slot / Port zu)"
    if "unreachable" in low or "10065" in low or "113" in low:
        return "Host nicht erreichbar"
    if "timed out" in low or "10060" in low:
        return "Zeitueberschreitung"
    if "reset" in low or "10054" in low:
        return "zurueckgesetzt (RST)"
    return str(err)


def optional_auth(sock, token):
    sock.settimeout(0.8)
    try:
        data = sock.recv(64)
    except socket.timeout:
        return True
    if data.startswith(b"HELLO") and b"AUTH-REQUIRED" in data:
        if not token:
            return False
        sock.sendall(("AUTH %s\n" % token).encode())
        try:
            return sock.recv(16).startswith(b"OK")
        except OSError:
            return False
    return True


class Conn:
    def __init__(self, cid, host, port, token, q):
        self.cid, self.host, self.port, self.token, self.q = cid, host, port, token, q
        self.stop = threading.Event()
        self.sock = None
        self.thread = threading.Thread(target=self.run, daemon=True)

    def start(self):
        self.thread.start()

    def emit(self, status, detail=""):
        self.q.put({"id": self.cid, "status": status, "detail": detail, "t": time.time()})

    def close(self):
        self.stop.set()
        if self.sock:
            try:
                self.sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                self.sock.close()
            except OSError:
                pass

    def run(self):
        self.emit("verbinde")
        try:
            s = socket.create_connection((self.host, self.port), timeout=CONNECT_TIMEOUT)
        except OSError as e:
            self.emit("fehlgeschlagen", describe(e))
            return
        self.sock = s
        enable_keepalive(s)
        try:
            if not optional_auth(s, self.token):
                self.emit("abgewiesen", "AUTH fehlgeschlagen")
                s.close()
                return
        except OSError as e:
            self.emit("fehlgeschlagen", "auth: " + describe(e))
            s.close()
            return

        self.emit("verbunden")
        s.settimeout(1.0)
        rx = 0
        while not self.stop.is_set():
            try:
                d = s.recv(1024)
                if d == b"":
                    self.emit("getrennt", "vom Server geschlossen (rx=%dB)" % rx)
                    break
                rx += len(d)
            except socket.timeout:
                continue
            except OSError as e:
                self.emit("getrennt", "%s (rx=%dB)" % (describe(e), rx))
                break
        else:
            self.emit("beendet", "manuell getrennt (rx=%dB)" % rx)
        try:
            s.close()
        except OSError:
            pass


class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("EUL Verbindungs-/Lasttest")
        self.geometry("780x560")
        self.minsize(640, 460)
        self.q = queue.Queue()
        self.conns = []
        self.state = {}          # id -> dict(status, detail, connected_at)
        self._build_ui()
        self.after(150, self._poll)

    def _build_ui(self):
        top = ttk.Frame(self)
        top.pack(fill="x", padx=6, pady=6)
        ttk.Label(top, text="Host:").grid(row=0, column=0, sticky="e")
        self.e_host = ttk.Entry(top, width=20)
        self.e_host.insert(0, DEFAULT_HOST)
        self.e_host.grid(row=0, column=1, padx=4)
        ttk.Label(top, text="Port:").grid(row=0, column=2, sticky="e")
        self.e_port = ttk.Entry(top, width=7)
        self.e_port.insert(0, str(DEFAULT_PORT))
        self.e_port.grid(row=0, column=3, padx=4)
        ttk.Label(top, text="Anzahl:").grid(row=0, column=4, sticky="e")
        self.sp_count = ttk.Spinbox(top, from_=1, to=100, width=5)
        self.sp_count.set(10)
        self.sp_count.grid(row=0, column=5, padx=4)
        ttk.Label(top, text="Token:").grid(row=0, column=6, sticky="e")
        self.e_token = ttk.Entry(top, width=14, show="*")
        self.e_token.grid(row=0, column=7, padx=4)

        self.btn_open = ttk.Button(top, text="Verbindungen oeffnen", command=self.on_open)
        self.btn_open.grid(row=0, column=8, padx=6)
        self.btn_close = ttk.Button(top, text="Alle trennen", command=self.on_close_all, state="disabled")
        self.btn_close.grid(row=0, column=9)

        # Zaehler
        cnt = ttk.Frame(self)
        cnt.pack(fill="x", padx=6)
        self.counters = {}
        for key, title, color in [("target", "Ziel", "#333"),
                                  ("connected", "Aktiv verbunden", "#127a12"),
                                  ("rejected", "Abgewiesen/Fehlg.", "#b00000"),
                                  ("dropped", "Getrennt", "#c07000"),
                                  ("total", "Versuche", "#333")]:
            f = ttk.Frame(cnt)
            f.pack(side="left", padx=12, pady=4)
            ttk.Label(f, text=title, foreground="#666").pack()
            v = tk.Label(f, text="0", font=("Segoe UI", 15, "bold"), fg=color)
            v.pack()
            self.counters[key] = v

        ttk.Label(self, text="Hinweis: der EUL erlaubt werkseitig max. 4 gleichzeitige Clients "
                             "(EUL_MAX_CLIENTS) - weitere werden abgewiesen/geschlossen.",
                  foreground="#777").pack(anchor="w", padx=8)

        # Verbindungs-Tabelle
        tblf = ttk.Frame(self)
        tblf.pack(fill="both", expand=True, padx=6, pady=4)
        cols = ("id", "status", "detail", "dauer")
        self.tree = ttk.Treeview(tblf, columns=cols, show="headings", height=12)
        for c, t, w in [("id", "#", 40), ("status", "Status", 130),
                        ("detail", "Detail", 380), ("dauer", "Dauer", 80)]:
            self.tree.heading(c, text=t)
            self.tree.column(c, width=w, anchor="w")
        self.tree.pack(side="left", fill="both", expand=True)
        sb = ttk.Scrollbar(tblf, command=self.tree.yview)
        sb.pack(side="right", fill="y")
        self.tree.config(yscrollcommand=sb.set)
        self.tree.tag_configure("verbunden", foreground="#127a12")
        self.tree.tag_configure("fehler", foreground="#b00000")
        self.tree.tag_configure("weg", foreground="#c07000")

    # ---------- Aktionen ----------
    def on_open(self):
        host = self.e_host.get().strip()
        try:
            port = int(self.e_port.get().strip())
            count = int(self.sp_count.get())
        except ValueError:
            messagebox.showerror("Fehler", "Port und Anzahl muessen Zahlen sein.")
            return
        token = self.e_token.get().strip()

        self.on_close_all()          # alte erst schliessen
        self.conns = []
        self.state = {}
        for item in self.tree.get_children():
            self.tree.delete(item)

        base = len(self.state)
        for i in range(count):
            cid = i + 1
            self.state[cid] = {"status": "start", "detail": "", "connected_at": None}
            self.tree.insert("", "end", iid=str(cid),
                             values=(cid, "start", "", ""))
            c = Conn(cid, host, port, token, self.q)
            self.conns.append(c)
        self.counters["target"].config(text=str(count))
        # leicht gestaffelt starten (nicht alle exakt gleichzeitig)
        self._start_index = 0
        self._spawn_next()
        self.btn_close.config(state="normal")

    def _spawn_next(self):
        if self._start_index < len(self.conns):
            self.conns[self._start_index].start()
            self._start_index += 1
            self.after(30, self._spawn_next)

    def on_close_all(self):
        for c in self.conns:
            c.close()
        self.btn_close.config(state="disabled")

    # ---------- Queue / Update ----------
    def _poll(self):
        try:
            while True:
                ev = self.q.get_nowait()
                st = self.state.get(ev["id"])
                if st is None:
                    continue
                st["status"] = ev["status"]
                st["detail"] = ev.get("detail", "")
                if ev["status"] == "verbunden" and st["connected_at"] is None:
                    st["connected_at"] = time.monotonic()
                if ev["status"] in ("getrennt", "beendet", "fehlgeschlagen", "abgewiesen"):
                    st["connected_at"] = st["connected_at"]  # behalten fuer Dauer
                    st["ended_at"] = time.monotonic()
        except queue.Empty:
            pass
        self._refresh()
        self.after(200, self._poll)

    def _refresh(self):
        conn = rej = drop = 0
        now = time.monotonic()
        for cid, st in self.state.items():
            status = st["status"]
            if status == "verbunden":
                conn += 1
                tag = "verbunden"
            elif status in ("fehlgeschlagen", "abgewiesen"):
                rej += 1
                tag = "fehler"
            elif status in ("getrennt",):
                drop += 1
                tag = "weg"
            elif status == "beendet":
                tag = "weg"
            else:
                tag = ""
            # Dauer
            ca = st.get("connected_at")
            if ca is not None:
                end = st.get("ended_at", now) if status != "verbunden" else now
                dur = "%ds" % int(end - ca)
            else:
                dur = ""
            self.tree.item(str(cid), values=(cid, status, st["detail"], dur),
                           tags=(tag,) if tag else ())
        self.counters["connected"].config(text=str(conn))
        self.counters["rejected"].config(text=str(rej))
        self.counters["dropped"].config(text=str(drop))
        self.counters["total"].config(text=str(len(self.state)))


if __name__ == "__main__":
    App().mainloop()
