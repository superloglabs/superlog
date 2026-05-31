export const INSTALL_PROMPT =
  "Run npx skills add superloglabs/skills --all and use the skills to install Superlog in this project";

export function buildInstallPrompt(apiKey: string): string {
  return `${INSTALL_PROMPT}\nUse API key ${apiKey}.`;
}
