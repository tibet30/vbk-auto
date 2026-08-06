declare module "*.css";
declare module "*.less";
declare module "*.scss";
declare module "*.sass";

declare module "*.module.css" {
  const classes: Record<string, string>;
  export default classes;
}

declare module "*.module.less" {
  const classes: Record<string, string>;
  export default classes;
}

declare module "*.module.scss" {
  const classes: Record<string, string>;
  export default classes;
}

declare module "*.module.sass" {
  const classes: Record<string, string>;
  export default classes;
}
