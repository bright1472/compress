// src/engine/shaders/kernel.wgsl

@group(0) @binding(0) var myTexture: texture_external;
@group(0) @binding(1) var mySampler: sampler;

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

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
    // 零拷贝核心：直接从外部纹理采样
    // 2026 标准使用 textureSampleBaseClampToEdge
    return textureSampleBaseClampToEdge(myTexture, mySampler, uv);
}
