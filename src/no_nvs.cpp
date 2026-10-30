// This app must not repair, erase, or open Launcher's or other apps' NVS data.
// Disable NVS at driver initialization too; persistent(false) alone sets RAM
// storage only AFTER esp_wifi_init has already attempted to open NVS.
// The one exception is this bot's own "rtbot" namespace in the default
// partition, which holds a dashboard-saved Wi-Fi network.
#include <string.h>
#include <nvs.h>
#include <nvs_flash.h>
#include <esp_wifi.h>
extern "C" {
esp_err_t __real_esp_wifi_init(const wifi_init_config_t *);
esp_err_t __real_nvs_flash_init_partition(const char *);
esp_err_t __real_nvs_open_from_partition(const char *, const char *, nvs_open_mode_t, nvs_handle_t *);

static bool botNamespace(const char *partition, const char *name) {
    return partition && name && !strcmp(partition, "nvs") && !strcmp(name, "rtbot");
}

esp_err_t __wrap_esp_wifi_init(const wifi_init_config_t *config) {
    if (!config) return ESP_ERR_INVALID_ARG;
    wifi_init_config_t ramConfig = *config;
    ramConfig.nvs_enable = false;
    return __real_esp_wifi_init(&ramConfig);
}
// Arduino's startup would erase NVS on some init errors; keep that a no-op.
esp_err_t __wrap_nvs_flash_init() { return ESP_OK; }
esp_err_t __wrap_nvs_flash_init_partition(const char *) { return ESP_OK; }
esp_err_t __wrap_nvs_flash_erase() { return ESP_ERR_NOT_SUPPORTED; }
esp_err_t __wrap_nvs_flash_erase_partition(const char *) { return ESP_ERR_NOT_SUPPORTED; }
esp_err_t __wrap_nvs_open(const char *name, nvs_open_mode_t mode, nvs_handle_t *handle) {
    if (!botNamespace("nvs", name)) return ESP_ERR_NVS_NOT_INITIALIZED;
    return __real_nvs_open_from_partition("nvs", name, mode, handle);
}
esp_err_t __wrap_nvs_open_from_partition(const char *partition, const char *name, nvs_open_mode_t mode, nvs_handle_t *handle) {
    if (!botNamespace(partition, name)) return ESP_ERR_NVS_NOT_INITIALIZED;
    return __real_nvs_open_from_partition(partition, name, mode, handle);
}
// Mount the shared partition without ever erasing it. On any error the bot
// simply runs without a saved network.
esp_err_t bot_storage_init() { return __real_nvs_flash_init_partition("nvs"); }
}
