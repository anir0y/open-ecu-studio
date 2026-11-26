/// <reference types="vite/client" />

interface Window {
  openEcuDesktop?: {
    platform: string;
    version: string;
    receiverRun?: {
      read(): string | null | false;
      write(value: string | null): boolean;
    };
  };
}
