/**
 * src/engine/gpu-pipeline.ts
 * WebGPU 完整管线 — Adapter/Device/Pipeline 初始化 + Shader 图像增强
 */

import kernelWGSL from './shaders/kernel.wgsl?raw';

export interface GPUCapability {
  available: boolean;
  adapterName: string;
  features: string[];
}

export class GpuPipeline {
  private device: GPUDevice | null = null;
  private pipeline: GPURenderPipeline | null = null;
  private sampler: GPUSampler | null = null;
  private ctx: GPUCanvasContext | null = null;

  /** 探测 + 初始化 GPU */
  async init(): Promise<GPUCapability> {
    if (!navigator.gpu) return { available: false, adapterName: 'N/A', features: [] };

    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return { available: false, adapterName: 'N/A', features: [] };

    const adapterInfo = await adapter.requestAdapterInfo();
    this.device = await adapter.requestDevice();
    this.sampler = this.device.createSampler({ magFilter: 'linear', minFilter: 'linear' });

    const shaderModule = this.device.createShaderModule({ code: kernelWGSL });

    this.pipeline = this.device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: shaderModule, entryPoint: 'vs_main' },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs_main',
        targets: [{ format: navigator.gpu.getPreferredCanvasFormat() }],
      },
      primitive: { topology: 'triangle-strip', stripIndexFormat: 'uint32' },
    });

    const features = [...adapter.features].map(f => String(f));
    return { available: true, adapterName: adapterInfo.description || adapterInfo.vendor || 'GPU', features };
  }

  /** 将 Canvas 绑定到 WebGPU 上下文 */
  attachCanvas(canvas: HTMLCanvasElement): void {
    if (!this.device) throw new Error('GPU not initialized');
    this.ctx = canvas.getContext('webgpu') as GPUCanvasContext;
    this.ctx.configure({
      device: this.device,
      format: navigator.gpu.getPreferredCanvasFormat(),
      alphaMode: 'premultiplied',
    });
  }

  /** 渲染一帧 VideoFrame 到 Canvas（零拷贝 GPU 采样） */
  renderFrame(videoFrame: VideoFrame): void {
    if (!this.device || !this.pipeline || !this.sampler || !this.ctx) return;

    const texture = this.device.importExternalTexture({ source: videoFrame as any });
    const bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: texture },
        { binding: 1, resource: this.sampler },
      ],
    });

    const commandEncoder = this.device.createCommandEncoder();
    const textureView = this.ctx.getCurrentTexture().createView();

    const passEncoder = commandEncoder.beginRenderPass({
      colorAttachments: [{
        view: textureView,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });

    passEncoder.setPipeline(this.pipeline);
    passEncoder.setBindGroup(0, bindGroup);
    passEncoder.draw(4, 1, 0, 0);
    passEncoder.end();

    this.device.queue.submit([commandEncoder.finish()]);
  }

  /** 能力检测（静态） */
  static async probe(): Promise<GPUCapability> {
    const instance = new GpuPipeline();
    return instance.init();
  }

  destroy(): void {
    this.device?.destroy();
    this.device = null;
    this.pipeline = null;
    this.ctx = null;
  }
}
