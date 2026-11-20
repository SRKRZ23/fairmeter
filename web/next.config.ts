import type { NextConfig } from "next";

const config: NextConfig = {
  // The shared config package ships TypeScript source.
  transpilePackages: ["@aevum-kit/aevum", "@fairmeter/sdk"],
};

export default config;
