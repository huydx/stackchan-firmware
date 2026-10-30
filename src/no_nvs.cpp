// This stateless app must not initialize, repair, erase, or open Launcher's NVS.
// Disable NVS at driver initialization too; persistent(false) alone sets RAM
// storage only AFTER esp_wifi_init has already attempted to open NVS.
#include <nvs.h>
#include <nvs_flash.h>
#include <esp_wifi.h>
extern "C" {
esp_err_t __real_esp_wifi_init(const wifi_init_config_t *);
esp_err_t __wrap_esp_wifi_init(const wifi_init_config_t *config) {
    if (!config) return ESP_ERR_INVALID_ARG;
    wifi_init_config_t ramConfig = *config;
    ramConfig.nvs_enable = false;
    return __real_esp_wifi_init(&ramConfig);
}
esp_err_t __wrap_nvs_flash_init() { return ESP_OK; }
esp_err_t __wrap_nvs_flash_init_partition(const char *) { return ESP_OK; }
esp_err_t __wrap_nvs_flash_erase() { return ESP_ERR_NOT_SUPPORTED; }
esp_err_t __wrap_nvs_flash_erase_partition(const char *) { return ESP_ERR_NOT_SUPPORTED; }
esp_err_t __wrap_nvs_open(const char *, nvs_open_mode_t, nvs_handle_t *) {
    return ESP_ERR_NVS_NOT_INITIALIZED;
}
esp_err_t __wrap_nvs_open_from_partition(const char *, const char *, nvs_open_mode_t, nvs_handle_t *) {
    return ESP_ERR_NVS_NOT_INITIALIZED;
}
}
