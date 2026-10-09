// Control UI type declarations define css contracts.
declare module "*.css";
declare module "*.css?inline" {
  const css: string;
  export default css;
}
