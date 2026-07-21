import { useEffect } from "react";
import { parseAttribution, persistFirstTouchAttribution } from "./signupAttribution.ts";

export function SignupSourceCapture() {
  useEffect(() => {
    const attr = parseAttribution(window.location.search, document.referrer);
    if (attr.source) {
      try {
        const existing = window.localStorage.getItem("superlog.signup_source");
        if (!existing) window.localStorage.setItem("superlog.signup_source", attr.source);
      } catch {
        // Attribution is best-effort when storage is unavailable.
      }
    }
    persistFirstTouchAttribution(window.localStorage, {
      ...attr,
      landingPath: window.location.pathname,
    });
  }, []);

  return null;
}
