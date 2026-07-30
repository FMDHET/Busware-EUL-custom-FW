#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdio.h>

#include "esp_err.h"

// -----------------------------------------------------------------------------
// Persistenz fuer den Geraete-Manager ("EO-Man"-Datenbestand).
//
// Gespeichert wird EIN JSON-Dokument mit dem kompletten Anwendungszustand des
// Portals: Geraete-Inventar, gespeicherte Filter, Telegramm-Vorlagen. Das
// Frontend haelt das Modell und schreibt es als Ganzes zurueck - dieselbe
// Semantik wie die .eodm-Datei im Desktop-Tool, nur auf dem Geraet.
//
// Ablage: SPIFFS auf der bereits reservierten "storage"-Partition (952 KB,
// siehe partitions.csv). Bewusst NICHT im NVS: dort liegen die WLAN-Zugangs-
// daten, und die 24-KB-Partition wuerde ein wachsendes Inventar irgendwann
// sprengen - ein voller NVS ist ein defektes Geraet.
//
// Schreiben laeuft ueber Temp-Datei + rename: ein Stromausfall mitten im
// Upload laesst das alte Dokument intakt statt es zu halbieren.
// -----------------------------------------------------------------------------

// Groesse, ab der ein Upload abgewiesen wird. 128 KB reichen fuer weit ueber
// 500 Geraete und lassen der Partition Reserve fuer den Temp-Zwilling.
#define EUL_DEVSTORE_MAX_BYTES  (128 * 1024)

// Mountet SPIFFS (formatiert beim ersten Mal). Idempotent - mehrfacher Aufruf
// ist ein No-Op. Fehler werden geloggt; die Firmware laeuft ohne Store weiter,
// devstore_available() ist dann false.
esp_err_t devstore_init(void);

// true, wenn das Dateisystem gemountet ist und gelesen/geschrieben werden kann.
bool devstore_available(void);

// Groesse des gespeicherten Dokuments in Bytes, 0 wenn keines existiert.
size_t devstore_size(void);

// Oeffnet das Dokument zum Lesen. NULL, wenn keines existiert oder der Store
// nicht verfuegbar ist. Der Aufrufer schliesst mit fclose().
FILE *devstore_open_read(void);

// Oeffnet die Temp-Datei zum Schreiben. NULL bei Fehler. Danach entweder
// devstore_commit() (macht das Dokument sichtbar) oder devstore_abort().
FILE *devstore_open_write(void);

// Schliesst die Temp-Datei und ersetzt damit das Dokument atomar.
esp_err_t devstore_commit(FILE *f);

// Schliesst die Temp-Datei und verwirft sie. Das alte Dokument bleibt.
void devstore_abort(FILE *f);

// Loescht das Dokument (Werksreset des Inventars).
esp_err_t devstore_clear(void);

// Belegung des Dateisystems fuer die Portal-Anzeige. Bei nicht verfuegbarem
// Store werden beide Werte 0.
void devstore_fs_info(size_t *total_out, size_t *used_out);
