import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.slabsngrabs.aco",
  appName: "Slabs N Grabs ACO",
  webDir: "mobile",
  server: {
    url: "https://slabsngrabsaco.com",
    cleartext: false,
    allowNavigation: [
      "slabsngrabsaco.com",
      "*.slabsngrabsaco.com",
      "checkout.stripe.com",
      "*.stripe.com"
    ]
  },
  ios: {
    contentInset: "automatic",
    backgroundColor: "#020914"
  },
  android: {
    backgroundColor: "#020914",
    allowMixedContent: false
  },
  plugins: {
    StatusBar: {
      style: "DARK",
      backgroundColor: "#020914"
    },
    Keyboard: {
      resize: "native"
    }
  }
};

export default config;
