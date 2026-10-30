import { proxyToPhp } from "../_utils/proxy-to-php.js";

export async function onRequest(context) {
  return proxyToPhp(context, "/uploads");
}
