"""Host checks for the boundaries that protect the existing Launcher install."""
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest

ROOT = Path(__file__).resolve().parents[1]


class LauncherSafety(unittest.TestCase):
    def test_upload_targets_fail_before_any_serial_action(self):
        # Execute the real SCons script with tiny stand-ins, never a live uploader.
        errors = types.ModuleType("SCons.Errors")
        errors.UserError = RuntimeError
        script = types.ModuleType("SCons.Script")
        modules = {"SCons": types.ModuleType("SCons"), "SCons.Errors": errors, "SCons.Script": script}
        saved = {key: sys.modules.get(key) for key in modules}
        sys.modules.update(modules)
        try:
            for target in ("upload", "uploadfs", "erase"):
                script.COMMAND_LINE_TARGETS = [target]
                with self.assertRaisesRegex(RuntimeError, "direct flashing is disabled"):
                    exec((ROOT / "launcher_build.py").read_text(), {"Import": lambda _: None})
            script.COMMAND_LINE_TARGETS = ["buildprog"]
            exec((ROOT / "launcher_build.py").read_text(), {"Import": lambda _: None})
        finally:
            for key, value in saved.items():
                if value is None:
                    sys.modules.pop(key, None)
                else:
                    sys.modules[key] = value

    def test_nvs_is_inaccessible_and_wifi_init_is_ram_only(self):
        with tempfile.TemporaryDirectory() as temporary:
            tmp = Path(temporary)
            (tmp / "nvs.h").write_text("""
#pragma once
typedef int esp_err_t;
typedef int nvs_open_mode_t;
typedef unsigned nvs_handle_t;
#define ESP_OK 0
#define ESP_ERR_NOT_SUPPORTED 1
#define ESP_ERR_NVS_NOT_INITIALIZED 2
#define ESP_ERR_INVALID_ARG 3
""")
            (tmp / "nvs_flash.h").write_text('#include "nvs.h"\n')
            (tmp / "esp_wifi.h").write_text("""
#include "nvs.h"
struct wifi_init_config_t { int before; bool nvs_enable; int after; };
""")
            (tmp / "test.cpp").write_text(f"""
#include <cassert>
#include "{ROOT / 'src/no_nvs.cpp'}"
static int calls;
extern "C" esp_err_t __real_esp_wifi_init(const wifi_init_config_t *cfg) {{
    ++calls;
    assert(!cfg->nvs_enable && cfg->before == 17 && cfg->after == 42);
    return 37;
}}
int main() {{
    nvs_handle_t handle = 99;
    assert(__wrap_nvs_flash_init() == ESP_OK);
    assert(__wrap_nvs_flash_init_partition("nvs") == ESP_OK);
    assert(__wrap_nvs_open("M5GFX", 1, &handle) == ESP_ERR_NVS_NOT_INITIALIZED);
    assert(__wrap_nvs_open_from_partition("muse_nvs", "wifi", 1, &handle) == ESP_ERR_NVS_NOT_INITIALIZED);
    assert(handle == 99);
    assert(__wrap_nvs_flash_erase() == ESP_ERR_NOT_SUPPORTED);
    assert(__wrap_nvs_flash_erase_partition("nvs") == ESP_ERR_NOT_SUPPORTED);
    wifi_init_config_t cfg = {{17, true, 42}};
    assert(__wrap_esp_wifi_init(&cfg) == 37);
    assert(cfg.nvs_enable && calls == 1);
    assert(__wrap_esp_wifi_init(nullptr) == ESP_ERR_INVALID_ARG);
    assert(calls == 1);
}}
""")
            subprocess.run(["c++", "-std=c++11", "-I", str(tmp), str(tmp / "test.cpp"), "-o", str(tmp / "test")], check=True)
            subprocess.run([str(tmp / "test")], check=True)


if __name__ == "__main__":
    unittest.main()
