#include "device_store.h"

#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include "esp_log.h"
#include "esp_spiffs.h"

static const char *TAG = "eul-devstore";

#define MOUNT_POINT   "/eo"
#define DOC_PATH      MOUNT_POINT "/eo.json"
#define TMP_PATH      MOUNT_POINT "/eo.tmp"

static bool s_mounted = false;

esp_err_t devstore_init(void)
{
    if (s_mounted) return ESP_OK;

    esp_vfs_spiffs_conf_t conf = {
        .base_path              = MOUNT_POINT,
        .partition_label        = "storage",
        // Nur ein Dokument + Temp-Zwilling gleichzeitig offen.
        .max_files              = 4,
        // Erstboot bzw. nach einem Partitionslayout-Wechsel ist SPIFFS leer -
        // dann formatieren statt den Store dauerhaft abzuschalten. Das dauert
        // einmalig einige Sekunden (952 KB loeschen); der Flash-Treiber
        // yieldet dabei (CONFIG_SPI_FLASH_YIELD_DURING_ERASE, IDF-Default),
        // der Idle-Watchdog schlaegt also nicht zu.
        .format_if_mount_failed = true,
    };

    esp_err_t r = esp_vfs_spiffs_register(&conf);
    if (r != ESP_OK) {
        ESP_LOGE(TAG, "SPIFFS-Mount fehlgeschlagen (%s) - Geraete-Inventar "
                      "wird nicht persistiert", esp_err_to_name(r));
        return r;
    }

    s_mounted = true;

    size_t total = 0, used = 0;
    if (esp_spiffs_info(conf.partition_label, &total, &used) == ESP_OK) {
        ESP_LOGI(TAG, "SPIFFS gemountet: %u KB gesamt, %u KB belegt",
                 (unsigned)(total / 1024), (unsigned)(used / 1024));
    }

    // Ein Temp-Rest bedeutet: der letzte Upload wurde abgebrochen (Reset,
    // Verbindungsabbruch). Das Dokument selbst ist davon unberuehrt, der Rest
    // haelt nur Platz fest.
    if (unlink(TMP_PATH) == 0) {
        ESP_LOGW(TAG, "abgebrochenen Upload aufgeraeumt");
    }

    return ESP_OK;
}

bool devstore_available(void)
{
    return s_mounted;
}

size_t devstore_size(void)
{
    if (!s_mounted) return 0;
    struct stat st;
    if (stat(DOC_PATH, &st) != 0) return 0;
    return (size_t)st.st_size;
}

FILE *devstore_open_read(void)
{
    if (!s_mounted) return NULL;
    return fopen(DOC_PATH, "rb");
}

FILE *devstore_open_write(void)
{
    if (!s_mounted) return NULL;
    FILE *f = fopen(TMP_PATH, "wb");
    if (!f) ESP_LOGE(TAG, "kann " TMP_PATH " nicht anlegen");
    return f;
}

esp_err_t devstore_commit(FILE *f)
{
    if (!f) return ESP_ERR_INVALID_ARG;

    // fclose() meldet auch Fehler, die erst beim Flush auffallen (volle
    // Partition). Nur bei sauberem Abschluss darf das alte Dokument weichen.
    if (fclose(f) != 0) {
        ESP_LOGE(TAG, "Schreibfehler beim Abschliessen - Dokument unveraendert");
        unlink(TMP_PATH);
        return ESP_FAIL;
    }

    // SPIFFS' rename() ueberschreibt ein bestehendes Ziel nicht zuverlaessig,
    // deshalb vorher explizit loeschen. Das kurze Fenster ohne Dokument ist
    // unkritisch: das Frontend haelt den Zustand ohnehin im Speicher.
    unlink(DOC_PATH);
    if (rename(TMP_PATH, DOC_PATH) != 0) {
        ESP_LOGE(TAG, "rename " TMP_PATH " -> " DOC_PATH " fehlgeschlagen");
        unlink(TMP_PATH);
        return ESP_FAIL;
    }
    return ESP_OK;
}

void devstore_abort(FILE *f)
{
    if (f) fclose(f);
    unlink(TMP_PATH);
}

esp_err_t devstore_clear(void)
{
    if (!s_mounted) return ESP_ERR_INVALID_STATE;
    unlink(TMP_PATH);
    // Kein Dokument vorhanden ist bereits der gewuenschte Zustand.
    if (unlink(DOC_PATH) != 0 && devstore_size() != 0) return ESP_FAIL;
    return ESP_OK;
}

void devstore_fs_info(size_t *total_out, size_t *used_out)
{
    size_t total = 0, used = 0;
    if (s_mounted) {
        if (esp_spiffs_info("storage", &total, &used) != ESP_OK) {
            total = 0;
            used  = 0;
        }
    }
    if (total_out) *total_out = total;
    if (used_out)  *used_out  = used;
}
