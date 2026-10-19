import type { Metadata, Viewport } from "next";
import CompassApp from "@/components/compass-app";
import { astanaInputDate } from "@/lib/format";
import "maplibre-gl/dist/maplibre-gl.css";
import "./globals.css";
import "./planner.css";

export const viewport: Viewport = {
  themeColor: "#087f5b",
  width: "device-width",
  initialScale: 1,
};

export const metadata: Metadata = {
  manifest: "/manifest.webmanifest",
  icons: { icon: "/icon.svg", apple: "/icon.svg" },
  appleWebApp: {
    capable: true,
    title: "Astana Compass",
    statusBarStyle: "default",
  },
  title: "Astana Compass — город в вашем темпе",
  description:
    "Прогулки по Астане с учётом времени, ваших условий и проверяемых источников. RU / ҚАЗ / EN.",
};
export const dynamic = "force-dynamic";
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ru">
      <body>
        <CompassApp
          initialStart={astanaInputDate(new Date())}
          allowFixtures={process.env.ASTANA_ALLOW_FIXTURES === "true"}
          mapProvider={
            process.env.ASTANA_MAP_PROVIDER === "none"
              ? "none"
              : process.env.ASTANA_MAP_PROVIDER === "osm"
                ? "osm"
                : "openfreemap"
          }
        >
          {children}
        </CompassApp>
      </body>
    </html>
  );
}
