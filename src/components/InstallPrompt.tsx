import { useSyncExternalStore, useState } from "react";
import {
  getInstallState,
  promptInstall,
  shouldOfferInstall,
  subscribeInstall,
} from "../lib/install";
import { DownloadIcon } from "./Icons";

/**
 * The install offer on the home hero. Chromium: one click runs the native
 * install dialog. iOS: no native prompt exists, so the button reveals the
 * Share → Add to Home Screen steps instead. Hidden entirely once the app
 * runs installed (standalone) or on browsers that can offer neither path.
 */
export function InstallButton() {
  const state = useSyncExternalStore(subscribeInstall, getInstallState);
  const [showSteps, setShowSteps] = useState(false);
  if (!shouldOfferInstall(state)) return null;
  const manual = state.ios && !state.canPrompt;

  function onClick() {
    if (!manual) {
      void promptInstall();
      return;
    }
    setShowSteps((v) => !v);
  }

  return (
    <div className="install-wrap">
      <button type="button" className="btn btn-ghost btn-sm install-btn" onClick={onClick}>
        <DownloadIcon size={14} /> Install app
      </button>
      {manual && showSteps && (
        <div className="install-hint" role="note">
          In Safari: tap <strong>Share</strong>, then <strong>Add to Home Screen</strong> to install
          maishare.
        </div>
      )}
    </div>
  );
}
