// Building footprints in metres (width across the row, length along the input→output axis, height).
// The docs file does not contain dimensions, so these come from the in-game measurements.
// Ports: inputs are on the "back" face, outputs on the "front" face, along the length axis.
export const FOOTPRINTS = {
  Build_SmelterMk1_C: { w: 6, l: 9, h: 9, short: 'Smelter' },
  Build_ConstructorMk1_C: { w: 8, l: 10, h: 8, short: 'Constructor' },
  Build_AssemblerMk1_C: { w: 10, l: 15, h: 11, short: 'Assembler' },
  Build_FoundryMk1_C: { w: 10, l: 9, h: 9, short: 'Foundry' },
  Build_ManufacturerMk1_C: { w: 18, l: 20, h: 12, short: 'Manufacturer' },
  Build_OilRefinery_C: { w: 10, l: 20, h: 31, short: 'Refinery' },
  Build_Packager_C: { w: 8, l: 8, h: 12, short: 'Packager' },
  Build_Blender_C: { w: 18, l: 16, h: 15, short: 'Blender' },
  Build_HadronCollider_C: { w: 24, l: 38, h: 32, short: 'Particle Accel.' },
  Build_Converter_C: { w: 16, l: 16, h: 17, short: 'Converter' },
  Build_QuantumEncoder_C: { w: 22, l: 48, h: 21, short: 'Quantum Encoder' },
  Build_GeneratorBiomass_Automated_C: { w: 8, l: 8, h: 7, short: 'Biomass Burner' },
  Build_GeneratorCoal_C: { w: 10, l: 26, h: 36, short: 'Coal Gen' },
  Build_GeneratorFuel_C: { w: 20, l: 20, h: 27, short: 'Fuel Gen' },
  Build_StorageContainerMk1_C: { w: 5, l: 10, h: 4, short: 'Storage' },
  Build_StorageContainerMk2_C: { w: 5, l: 10, h: 8, short: 'Ind. Storage' },
  Build_MinerMk1_C: { w: 6, l: 14, h: 18, short: 'Miner Mk1' },
  Build_MinerMk2_C: { w: 6, l: 14, h: 18, short: 'Miner Mk2' },
  Build_MinerMk3_C: { w: 6, l: 14, h: 18, short: 'Miner Mk3' },
  Build_WaterPump_C: { w: 20, l: 20, h: 26, short: 'Water Extr.' },
};

// Splitter / merger / lift footprint used in sketches (they snap onto belts).
export const ATTACHMENT_SIZE = 2;
export const LANE_SPACING = 2; // metres between parallel belts
export const FOUNDATION = 8; // foundation tile edge (m)

export function footprint(buildingId) {
  return FOOTPRINTS[buildingId] || { w: 10, l: 10, h: 10, short: buildingId.replace(/^Build_|_C$/g, '') };
}

/** Row pitch: machines snapped to a 2 m grid with a 2 m gap, kept on a foundation-friendly spacing. */
export function machinePitch(buildingId) {
  const { w } = footprint(buildingId);
  if (w <= 6) return 8; // smelters: one per foundation
  if (w <= 8) return 8; // constructors: one per foundation, touching
  return Math.ceil((w + 2) / 2) * 2;
}
