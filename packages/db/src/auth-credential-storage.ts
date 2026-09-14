import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";

function looksLikeBetterAuthCiphertext(value: string): boolean {
  return value.startsWith("$ba$") || (value.length % 2 === 0 && /^[0-9a-f]+$/i.test(value));
}

export async function protectBetterAuthToken(token: string, secret: string): Promise<string> {
  if (await isProtectedBetterAuthToken(token, secret)) return token;
  return symmetricEncrypt({ key: secret, data: token });
}

export async function isProtectedBetterAuthToken(token: string, secret: string): Promise<boolean> {
  if (looksLikeBetterAuthCiphertext(token)) {
    try {
      await symmetricDecrypt({ key: secret, data: token });
      return true;
    } catch (error) {
      // Versioned envelopes are unambiguously ciphertext. A failed decrypt is
      // a key/corruption problem and must not be re-encrypted as if plaintext.
      if (token.startsWith("$ba$")) throw error;
      // Provider tokens can legitimately be hex strings. If a bare-hex value
      // does not authenticate as ciphertext, treat it as legacy plaintext.
    }
  }
  return false;
}
