declare interface IResponse<T = unknown> {
  code: number;
  message: string;
  data: T;
}

declare type Fn = () => void;

declare module 'gif.js.optimized' {
  export interface GIFOptions {
    workers?: number;
    quality?: number;
    workerScript?: string;
    width?: number;
    height?: number;
  }

  export interface GIFFrameOptions {
    copy?: boolean;
    delay?: number;
  }

  export default class GIF {
    constructor(options?: GIFOptions);
    on(event: 'finished', callback: (blob: Blob) => void): void;
    addFrame(source: CanvasImageSource, options?: GIFFrameOptions): void;
    render(): void;
    abort(): void;
  }
}
