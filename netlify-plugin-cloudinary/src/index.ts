import fs from 'node:fs/promises';
import path from 'node:path';
import { glob } from 'glob';

import { Inputs } from './types/integration';

import {
  configureCloudinary,
  updateHtmlImagesToCloudinary,
  getCloudinaryUrl,
  Assets,
  getTransformationsFromInputs
} from './lib/cloudinary';
import { findAssetsByPath } from './lib/util';

import { PUBLIC_ASSET_PATH } from './data/cloudinary';
import {
  ERROR_API_CREDENTIALS_REQUIRED,
  ERROR_CLOUD_NAME_REQUIRED,
  ERROR_INVALID_IMAGES_PATH,
  ERROR_NETLIFY_HOST_CLI_SUPPORT,
  ERROR_NETLIFY_HOST_UNKNOWN,
  ERROR_SITE_NAME_REQUIRED,
} from './data/errors';

/**
 * Type needs improvement
 * Information was found here <a href="https://docs.netlify.com/integrations/build-plugins/create-plugins/#netlifyconfig">Netlify Config</a>
 */

type NetlifyConfig = {
  redirects: Array<{
    from: string;
    to?: string;
    status?: number;
    force?: boolean;
    signed?: string;
    query?: Partial<Record<string, string>>;
    headers?: Partial<Record<string, string>>;
    conditions?: Partial<
      Record<'Language' | 'Role' | 'Country' | 'Cookie', readonly string[]>
    >;
  }>;
  headers: Array<{
    for: string;
    values: unknown; // marked as unknown because is not required here.
  }>;
  functions: {
    directory: string;
  };
  build: {
    command: string;
    environment: Record<string, string>;
    edge_functions: string;
    processing: Record<string, unknown>;
  };
};
type Constants = {
  CONFIG_PATH?: string;
  PUBLISH_DIR: string;
  FUNCTIONS_SRC: string;
  FUNCTIONS_DIST: string;
  IS_LOCAL: boolean;
  NETLIFY_BUILD_VERSION: `${string}.${string}.${string}`;
  SITE_ID: string;
};



type Utils = {
  build: {
    failBuild: (message: string, { error }?: { error: Error }) => void;
    failPlugin: (message: string, { error }?: { error: Error }) => void;
    cancelBuild: (message: string, { error }?: { error: Error }) => void;
  };
  status: {
    show: ({
      title,
      summary,
      text,
    }: {
      title: string;
      summary: string;
      text: string;
    }) => void;
  };
};
type OnBuildParams = {
  netlifyConfig: NetlifyConfig;
  constants: Constants;
  inputs: Inputs;
  utils: Utils;
};
type OnPostBuildParams = Omit<OnBuildParams, 'netlifyConfig'>;

const CLOUDINARY_ASSET_DIRECTORIES = [
  {
    name: 'images',
    inputKey: 'imagesPath',
    path: '/images',
  },
];

/**
 * TODO
 * - Handle srcset
 */

const _cloudinaryAssets = { images: {} } as Assets;
const globalErrors = [];

export async function onBuild({
  netlifyConfig,
  constants,
  inputs,
  utils,
}: OnBuildParams) {
  console.log('[Cloudinary] Creating redirects...');

  let host = process.env.URL;

  if (process.env.CONTEXT === 'branch-deploy' || process.env.CONTEXT === 'deploy-preview') {
    host = process.env.DEPLOY_PRIME_URL || ''
  }

  console.log(`[Cloudinary] Using host: ${host}`);

  const { PUBLISH_DIR } = constants;

  const {
    cname,
    deliveryType,
    folder = process.env.SITE_NAME,
    imagesPath = CLOUDINARY_ASSET_DIRECTORIES.find(
      ({ inputKey }) => inputKey === 'imagesPath',
    )?.path,
    maxSize,
    privateCdn,
    uploadPreset,
  } = inputs;

  if (!folder) {
    console.error(`[Cloudinary] ${ERROR_SITE_NAME_REQUIRED}`);
    utils.build.failPlugin(ERROR_SITE_NAME_REQUIRED);
    return;
  }

  if (!host && deliveryType === 'fetch') {
    console.warn(`[Cloudinary] ${ERROR_NETLIFY_HOST_UNKNOWN}`);
    console.log(`[Cloudinary] ${ERROR_NETLIFY_HOST_CLI_SUPPORT}`);
    return;
  }

  const cloudName = process.env.CLOUDINARY_CLOUD_NAME || inputs.cloudName;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;

  if (!cloudName) {
    console.error(`[Cloudinary] ${ERROR_CLOUD_NAME_REQUIRED}`);
    utils.build.failBuild(ERROR_CLOUD_NAME_REQUIRED);
    return;
  }

  if (deliveryType === 'upload' && (!apiKey || !apiSecret)) {
    console.error(`[Cloudinary] ${ERROR_API_CREDENTIALS_REQUIRED}`);
    utils.build.failBuild(ERROR_API_CREDENTIALS_REQUIRED);
    return;
  }

  configureCloudinary({
    // Base credentials
    cloudName,
    apiKey,
    apiSecret,

    // Configuration
    cname,
    privateCdn,
  });

  const transformations = getTransformationsFromInputs(inputs);

  // Look for any available images in the provided imagesPath to collect
  // asset details and to grab a Cloudinary URL to use later

  if (typeof imagesPath === 'undefined') {
    console.error(`[Cloudinary] ${ERROR_INVALID_IMAGES_PATH}`)
    throw new Error(ERROR_INVALID_IMAGES_PATH);
  }

  const imagesFiles = findAssetsByPath({
    baseDir: PUBLISH_DIR,
    path: imagesPath,
  });

  if (imagesFiles.length === 0) {
    console.warn(`[Cloudinary] No image files found in ${imagesPath}`);
    console.log(
      `[Cloudinary] Did you update your images path? You can set the imagesPath input in your Netlify config.`,
    );
  }

  try {
    _cloudinaryAssets.images = await Promise.all(
      imagesFiles.map(async image => {
        const publishPath = image.replace(PUBLISH_DIR, '');

        const cloudinary = await getCloudinaryUrl({
          deliveryType,
          folder,
          path: publishPath,
          localDir: PUBLISH_DIR,
          uploadPreset,
          remoteHost: host,
          transformations
        });

        return {
          publishPath,
          ...cloudinary,
        };
      }),
    );
  } catch (e) {
    globalErrors.push(e)
  }

  // If the delivery type is set to upload, we need to be able to map individual assets based on their public ID,
  // which would require a dynamic middle solution, but that adds more hops than we want, so add a new redirect
  // for each asset uploaded

  if (deliveryType === 'upload') {
    await Promise.all(
      Object.keys(_cloudinaryAssets).flatMap(mediaType => {
        // @ts-expect-error what are the expected mediaTypes that will be stored in _cloudinaryAssets
        if (Object.hasOwn(_cloudinaryAssets[mediaType], 'map')) {
          // @ts-expect-error what are the expected mediaTypes that will be stored in _cloudinaryAssets
          return _cloudinaryAssets[mediaType].map(async asset => {
            const { publishPath, cloudinaryUrl } = asset;
            netlifyConfig.redirects.unshift({
              from: `${publishPath}*`,
              to: cloudinaryUrl,
              status: 302,
              force: true,
            });
          });
        }
      }),
    );
  }

  // If the delivery type is fetch, we're able to use the public URL and pass it right along "as is", so
  // we can create generic redirects. The tricky thing is to avoid a redirect loop, we modify the
  // path, so that we can safely allow Cloudinary to fetch the media remotely

  if (deliveryType === 'fetch') {
    await Promise.all(
      CLOUDINARY_ASSET_DIRECTORIES.map(
        async ({ inputKey, path: defaultPath }) => {
          let mediaPaths = inputs[inputKey as keyof Inputs] || defaultPath;

          // Unsure how to type the above so that Inputs['privateCdn'] doesnt mess up types here

          if (!Array.isArray(mediaPaths) && typeof mediaPaths !== 'string') return;

          if (!Array.isArray(mediaPaths)) {
            mediaPaths = [mediaPaths];
          }

          mediaPaths.forEach(async mediaPath => {
            const cldAssetPath = `/${path.join(PUBLIC_ASSET_PATH, mediaPath)}`;
            const cldAssetUrl = `${host}${cldAssetPath}`;
            try {
              const { cloudinaryUrl: assetRedirectUrl } = await getCloudinaryUrl({
                deliveryType: 'fetch',
                folder,
                path: `${cldAssetUrl}/:splat`,
                uploadPreset,
              });

              netlifyConfig.redirects.unshift({
                from: `${cldAssetPath}/*`,
                to: `${mediaPath}/:splat`,
                status: 200,
                force: true,
              });

              netlifyConfig.redirects.unshift({
                from: `${mediaPath}/*`,
                to: assetRedirectUrl,
                status: 302,
                force: true,
              });
            } catch (error) {
              globalErrors.push(error)
            }
          })
        })
    )
  }


}

// Post build looks through all of the output HTML and rewrites any src attributes to use a cloudinary URL
// This only solves on-page references until any JS refreshes the DOM

export async function onPostBuild({
  constants,
  inputs,
  utils,
}: OnPostBuildParams) {
  console.log('[Cloudinary] Replacing on-page images with Cloudinary URLs...');

  let host = process.env.URL;

  if (process.env.CONTEXT === 'branch-deploy' || process.env.CONTEXT === 'deploy-preview') {
    host = process.env.DEPLOY_PRIME_URL || ''
  }


  console.log(`[Cloudinary] Using host: ${host}`);

  const { PUBLISH_DIR } = constants;
  const {
    cname,
    deliveryType,
    folder = process.env.SITE_NAME,
    privateCdn,
    uploadPreset,
  } = inputs;

  if (!folder) {
    console.error(`[Cloudinary] ${ERROR_SITE_NAME_REQUIRED}`);
    utils.build.failPlugin(ERROR_SITE_NAME_REQUIRED);
    return;
  }

  const cloudName = process.env.CLOUDINARY_CLOUD_NAME || inputs.cloudName;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;

  if (!cloudName) {
    console.error(`[Cloudinary] ${ERROR_CLOUD_NAME_REQUIRED}`);
    utils.build.failBuild(ERROR_CLOUD_NAME_REQUIRED);
    return;
  }

  if (deliveryType === 'upload' && (!apiKey || !apiSecret)) {
    console.error(`[Cloudinary] ${ERROR_API_CREDENTIALS_REQUIRED}`);
    utils.build.failBuild(ERROR_API_CREDENTIALS_REQUIRED);
    return;
  }

  configureCloudinary({
    // Base credentials
    cloudName,
    apiKey,
    apiSecret,

    // Configuration
    cname,
    privateCdn,
  });

  const transformations = getTransformationsFromInputs(inputs);

  // Find all HTML source files in the publish directory

  const pages = glob.sync(`${PUBLISH_DIR}/**/*.html`);

  const results = await Promise.all(
    pages.map(async page => {
      const sourceHtml = await fs.readFile(page, 'utf-8');

      const { html, errors } = await updateHtmlImagesToCloudinary(sourceHtml, {
        assets: _cloudinaryAssets,
        deliveryType,
        uploadPreset,
        folder,
        localDir: PUBLISH_DIR,
        remoteHost: host,
        transformations
      });

      await fs.writeFile(page, html);

      return {
        page,
        errors,
      };
    }),
  );

  const errors = results.filter(({ errors }) => errors.length > 0);
  // Collect the errors in the global scope to be used in the summary onEnd
  globalErrors.push(...errors)

}


export function onEnd({ utils }: { utils: Utils }) {
  const summary = globalErrors.length > 0 ? `Cloudinary build plugin completed with ${globalErrors.length} errors` : "Cloudinary build plugin completed successfully"
  const text = globalErrors.length > 0 ? `The build process found ${globalErrors.length} errors. Check build logs for more information` : "No errors found during build"
  utils.status.show({
    title: "[Cloudinary] Done.",
    // Required.
    summary,
    text
  });
}
