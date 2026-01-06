export interface AnimationInfo {
  name: string;
  duration: number;
}

export interface ModelMetadata {
  name: string;
  animations: AnimationInfo[];
  boneCount: number;
}

export interface SceneConfig {
  cameraPosition: { x: number; y: number; z: number };
  lookAt: { x: number; y: number; z: number };
  mainLightColor: string;
  mainLightIntensity: number;
  mainLightPosition: { x: number; y: number; z: number };
  ambientIntensity: number;
  ambientColor: string;
  environmentVibe: 'studio' | 'night' | 'sunset' | 'neon';
  backgroundColor: string;
  exposure: number;
  shadowsEnabled: boolean;
  animationSpeed: number;
  fov: number;
}

export interface RenderingConfig {
  fps: number;
  width: number;
  height: number;
  bitrate: number;
  format: 'webm' | 'mp4' | 'gif';
  duration: number;
  gifQuality: number;
}
