import config from "../../apps/web/eslint.config.mjs";
const e2eConfig = [
  ...config,
  {
    settings: { react: { version: "19.3" } },
    rules: { "@next/next/no-html-link-for-pages": "off" },
  },
];
export default e2eConfig;
