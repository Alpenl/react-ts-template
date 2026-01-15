export interface AnimationInfo {
  name: string;
  duration: number;
}

export interface ModelMetadata {
  name: string;
  animations: AnimationInfo[];
  boneCount: number;
}

export interface ExampleItem {
  id: number;
  label: number;
  fbxUrl: string;
  videoUrl: string;
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
  fov: number;
}
