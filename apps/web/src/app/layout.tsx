import type { Metadata } from "next";
import "maplibre-gl/dist/maplibre-gl.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Astana Compass — город в вашем темпе",
  description:
    "Прогулки по Астане с учётом времени, ваших условий и проверяемых источников. RU / ҚАЗ / EN.",
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
