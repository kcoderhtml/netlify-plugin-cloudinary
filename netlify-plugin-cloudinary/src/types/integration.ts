/**
 * this type is built based on the content of the plugin manifest file
 * Information found here https://docs.netlify.com/integrations/build-plugins/create-plugins/#inputs
 */
export type Inputs = {
  cloudName: string;
  cname: string;
  deliveryType: string;
  folder: string;
  imagesPath: string | Array<string>;
  loadingStrategy: string;
  maxSize: {
    dpr: number | string;
    height: number;
    width: number;
  };
  privateCdn: boolean;
  uploadPreset: string;
};