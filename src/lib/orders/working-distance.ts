export const WORKING_DISTANCE = { min: 350, max: 550, step: 5 } as const;
export const validWorkingDistance = (value: number) =>
  Number.isInteger(value) &&
  value >= WORKING_DISTANCE.min &&
  value <= WORKING_DISTANCE.max;
