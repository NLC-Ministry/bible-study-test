import { OFFLINE_BIBLE_CATALOG } from "./OfflineBibleRepository.js";

function formatDate(value) {
  if (!value) return "";
  try {
    return new Intl.DateTimeFormat("zh-TW", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
  } catch {
    return "";
  }
}

export async function initOfflineBibleControls(repository) {
  const root = document.getElementById("offline-bible-settings");
  if (!root || !repository || root.dataset.bound === "true") return;
  root.dataset.bound = "true";

  const render = async () => {
    for (const translation of Object.keys(OFFLINE_BIBLE_CATALOG)) {
      const button = root.querySelector(`[data-offline-bible-action="${translation}"]`);
      const status = root.querySelector(`[data-offline-bible-status="${translation}"]`);
      if (!button || !status) continue;
      const installed = await repository.getInstalledPack(translation);
      button.dataset.installed = String(Boolean(installed));
      button.textContent = installed ? "移除" : "下載";
      button.classList.toggle("offline-bible-action--remove", Boolean(installed));
      status.textContent = installed
        ? `已下載 1,189 章・${formatDate(installed.downloadedAt)}`
        : `${OFFLINE_BIBLE_CATALOG[translation].license}・尚未下載`;
    }
  };

  root.querySelectorAll("[data-offline-bible-action]").forEach(button => {
    button.addEventListener("click", async () => {
      const translation = button.dataset.offlineBibleAction;
      const status = root.querySelector(`[data-offline-bible-status="${translation}"]`);
      const installed = await repository.getInstalledPack(translation);
      if (installed) {
        if (!window.confirm(`要移除「${installed.title}」的離線經文嗎？`)) return;
        button.disabled = true;
        try {
          await repository.removePack(translation);
          window.showToast?.("離線經文已移除");
        } finally {
          button.disabled = false;
          await render();
        }
        return;
      }

      if (!navigator.onLine) {
        window.showToast?.("請先連上網路再下載離線聖經");
        return;
      }
      button.disabled = true;
      button.textContent = "準備中";
      try {
        await repository.downloadPack(translation, progress => {
          if (status) status.textContent = progress == null ? "正在下載…" : `正在下載並驗證… ${progress}%`;
          button.textContent = progress == null ? "下載中" : `${progress}%`;
        });
        window.showToast?.("完整聖經已可離線閱讀");
      } catch (error) {
        console.error("Offline Bible download failed", error);
        window.showToast?.(error?.message || "離線聖經下載失敗，請稍後再試");
      } finally {
        button.disabled = false;
        await render();
      }
    });
  });

  repository.addEventListener("status", render);
  await render();
}
