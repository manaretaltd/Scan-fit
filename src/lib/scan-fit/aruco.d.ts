declare module "js-aruco2" {
  type ArucoAPI = {
    Detector: new (options: {
      dictionaryName: string;
      maxHammingDistance: number;
    }) => {
      detect(
        image: ImageData,
      ): {
        id: number;
        corners: { x: number; y: number }[];
        hammingDistance: number;
      }[];
    };
    Dictionary: new (name: string) => { generateSVG(id: number): string };
  };
  const aruco: { AR: ArucoAPI };
  export default aruco;
}
