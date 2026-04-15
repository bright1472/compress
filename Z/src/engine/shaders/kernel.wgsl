// src/engine/shaders/kernel.wgsl
// Titan GPU Image Enhancement Kernel
// 功能：亮度/对比度调整 + 简易降噪 (Box Blur Approximation)

@group(0) @binding(0) var myTexture: texture_external;
@group(0) @binding(1) var mySampler: sampler;

// 将来可通过 Uniform Buffer 动态下发参数
// 当前使用保守默认值（无视觉破坏性）
const BRIGHTNESS: f32 = 0.0;   // -0.5 ~ 0.5
const CONTRAST: f32 = 1.05;    // 0.5 ~ 2.0, 1.0 = 不变
const SATURATION: f32 = 1.08;  // 0.0 ~ 2.0, 1.0 = 不变
const SHARPNESS: f32 = 0.15;   // 0.0 ~ 1.0

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
};

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
    var pos = array<vec2f, 4>(
        vec2f(-1.0,  1.0),
        vec2f( 1.0,  1.0),
        vec2f(-1.0, -1.0),
        vec2f( 1.0, -1.0)
    );
    var uv = array<vec2f, 4>(
        vec2f(0.0, 0.0),
        vec2f(1.0, 0.0),
        vec2f(0.0, 1.0),
        vec2f(1.0, 1.0)
    );

    var output: VertexOutput;
    output.position = vec4f(pos[vertexIndex], 0.0, 1.0);
    output.uv = uv[vertexIndex];
    return output;
}

// ── 颜色空间工具 ──────────────────────────────────────────────────
fn rgb_to_luminance(c: vec3f) -> f32 {
    return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

fn adjust_contrast(color: vec3f, factor: f32) -> vec3f {
    return (color - vec3f(0.5)) * factor + vec3f(0.5);
}

fn adjust_saturation(color: vec3f, factor: f32) -> vec3f {
    let lum = rgb_to_luminance(color);
    return mix(vec3f(lum), color, factor);
}

// ── Unsharp Mask (锐化) ──────────────────────────────────────────
fn sample_offset(uv: vec2f, dx: f32, dy: f32) -> vec3f {
    return textureSampleBaseClampToEdge(myTexture, mySampler, uv + vec2f(dx, dy)).rgb;
}

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
    let center = textureSampleBaseClampToEdge(myTexture, mySampler, uv);
    var color = center.rgb;

    // 1. 亮度
    color = color + vec3f(BRIGHTNESS);

    // 2. 对比度
    color = adjust_contrast(color, CONTRAST);

    // 3. 饱和度
    color = adjust_saturation(color, SATURATION);

    // 4. Unsharp Mask 锐化
    let texelSize = vec2f(1.0 / 1920.0, 1.0 / 1080.0); // 近似像素尺寸
    let blur = (
        sample_offset(uv, -texelSize.x, 0.0) +
        sample_offset(uv, texelSize.x, 0.0) +
        sample_offset(uv, 0.0, -texelSize.y) +
        sample_offset(uv, 0.0, texelSize.y)
    ) * 0.25;
    let sharpened = color + (color - blur) * SHARPNESS;

    // 5. Clamp 防止溢出
    return vec4f(clamp(sharpened, vec3f(0.0), vec3f(1.0)), center.a);
}
