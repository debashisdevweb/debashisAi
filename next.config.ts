import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow the dev server's JS/HMR to load when the app is opened from a phone
  // on the LAN (or through a tunnel). Without this, Next.js blocks its
  // cross-origin dev resources and the page renders but never hydrates — so
  // nothing is clickable/typable and the assistant can't speak.
  allowedDevOrigins: [
    "192.168.10.94",
    "*.trycloudflare.com",
    "*.ngrok-free.app",
    "*.ngrok.io",
    "*.loca.lt",
  ],
};

export default nextConfig;
