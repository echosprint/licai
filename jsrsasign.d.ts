declare module "jsrsasign" {
  export const KJUR: {
    crypto: {
      Signature: new (opts: { alg: string }) => {
        init(key: any): void;
        updateString(data: string): void;
        sign(): string;
      };
    };
  };
  export const KEYUTIL: {
    getKey(key: string | Buffer): any;
  };
  export function hextob64(hex: string): string;
}
