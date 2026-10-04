import * as THREE from 'three';
import { VehicleModelInfo } from '../simulation/VehicleCatalog';
import {
  GameMaterials,
  TrackMeshBuilder,
  StationMeshBuilder,
  StructureMeshBuilder,
  VehicleMeshBuilder
} from '../graphics';

/**
 * 3Dモデル生成ファサードクラス
 * 実体は src/graphics/ 配下の各MeshBuilderに分離されています。
 * 既存シミュレーションコードとの後方互換性を保つために委譲します。
 */
export class ModelFactory {
  public static readonly CAR_SPACING = VehicleMeshBuilder.CAR_SPACING;

  public static updateMaterialsTimeOfDay(isNight: boolean): void {
    GameMaterials.updateMaterialsTimeOfDay(isNight);
  }

  public static createGroundTrack(rotation: number = 0, hasPole: boolean = false): THREE.Group {
    return TrackMeshBuilder.createGroundTrack(rotation, hasPole);
  }

  public static createTunnelTrack(rotation: number = 0, portalEnds?: { start?: boolean; end?: boolean }): THREE.Group {
    return TrackMeshBuilder.createTunnelTrack(rotation, portalEnds);
  }

  public static createCurveTrackSegment(
    curveDir: 'N_E' | 'E_S' | 'S_W' | 'W_N',
    isElevated: boolean = false,
    pierHeight: number = 3.0,
    isTunnel: boolean = false
  ): THREE.Group {
    return TrackMeshBuilder.createCurveTrackSegment(curveDir, isElevated, pierHeight, isTunnel);
  }

  public static createSwitchHub(
    forward: number = 0,
    isDiverged: boolean = false,
    isElevated: boolean = false,
    branchSide: 'left' | 'right' = 'right',
    pierHeight: number = 3.0,
    isTunnel: boolean = false
  ): THREE.Group {
    return TrackMeshBuilder.createSwitchHub(forward, isDiverged, isElevated, branchSide, pierHeight, isTunnel);
  }

  public static createScissorsCrossingTile(
    along: number,
    role: 0 | 1 | 2 | 3,
    isElevated: boolean = false,
    crossingState: 'straight' | 'cross-a' | 'cross-b' = 'straight',
    pierHeight: number = 3.0,
    isTunnel: boolean = false
  ): THREE.Group {
    return TrackMeshBuilder.createScissorsCrossingTile(along, role, isElevated, crossingState, pierHeight, isTunnel);
  }

  public static createLevelCrossing(railAxis: number = 0): THREE.Group {
    return TrackMeshBuilder.createLevelCrossing(railAxis);
  }

  public static createSlopeTrackPart(rotation: number = 0, reversed: boolean = false, part: number = 0): THREE.Group {
    return TrackMeshBuilder.createSlopeTrackPart(rotation, reversed, part);
  }

  public static createUndergroundSlopeTrackPart(rotation: number = 0, reversed: boolean = false, part: number = 0): THREE.Group {
    return TrackMeshBuilder.createUndergroundSlopeTrackPart(rotation, reversed, part);
  }

  public static createElevatedTrack(rotation: number = 0, showPier: boolean = true, pierHeight: number = 3.0): THREE.Group {
    return TrackMeshBuilder.createElevatedTrack(rotation, showPier, pierHeight);
  }

  public static createStation(
    rotation: number = 0,
    isElevated: boolean = false,
    part: 'single' | 'start' | 'mid' | 'end' = 'single',
    platformSide: 'left' | 'right' = 'right',
    stationName: string = '駅',
    pierHeight: number = 3.0,
    isGhost: boolean = false
  ): THREE.Group {
    return StationMeshBuilder.createStation(rotation, isElevated, part, platformSide, stationName, pierHeight, isGhost);
  }

  public static updateStationSign(mesh: THREE.Object3D, newName: string): void {
    StationMeshBuilder.updateSignboardText(mesh, newName);
  }

  public static createSignalYard(
    rotation: number = 0,
    isElevated: boolean = false,
    side: 'left' | 'right' = 'right',
    pierHeight: number = 3.0
  ): THREE.Group {
    return StationMeshBuilder.createSignalYard(rotation, isElevated, side, pierHeight);
  }

  public static createCargoStation(
    rotation: number = 0,
    isElevated: boolean = false,
    side: 'left' | 'right' = 'right',
    pierHeight: number = 3.0
  ): THREE.Group {
    return StationMeshBuilder.createCargoStation(rotation, isElevated, side, pierHeight);
  }

  public static createSignalPost(state: 'green' | 'red' | 'yellow' = 'green'): THREE.Group {
    return StationMeshBuilder.createSignalPost(state);
  }

  public static createRoad(rotation: number = 0): THREE.Group {
    return StructureMeshBuilder.createRoad(rotation);
  }

  public static createHouse(type: number = 0, level: number = 1): THREE.Group {
    return StructureMeshBuilder.createHouse(type, level);
  }

  public static createCommercialBuilding(level: number = 1): THREE.Group {
    return StructureMeshBuilder.createCommercialBuilding(level);
  }

  public static createIndustrialBuilding(level: number = 1): THREE.Group {
    return StructureMeshBuilder.createIndustrialBuilding(level);
  }

  public static createTree(): THREE.Group {
    return StructureMeshBuilder.createTree();
  }

  public static createTrainFormation(
    modelInfo: VehicleModelInfo,
    carCount: number = 3
  ): { group: THREE.Group; cars: THREE.Group[] } {
    return VehicleMeshBuilder.createTrainFormation(modelInfo, carCount);
  }
}
