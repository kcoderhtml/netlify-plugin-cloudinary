const fs = require('fs').promises;
const path = require('path');
const { JSDOM } = require('jsdom');

const { onPostBuild } = require('../src/');

const mocksPath = path.join(__dirname, 'mocks/html');
const tempPath = path.join(mocksPath, 'temp');

async function mkdir(directoryPath) {
  let dir;
  try {
    dir = await fs.stat(directoryPath);
  } catch(e) {}
  if ( dir && dir.isDirectory() ) return;
  await fs.mkdir(directoryPath);
}

describe('onPostBuild', () => {
  const ENV_ORIGINAL = process.env;

  beforeAll(async () => {
    await mkdir(tempPath);
  });

  beforeEach(async () => {
    jest.resetModules();

    process.env = { ...ENV_ORIGINAL };

    process.env.SITE_NAME = 'cool-site';
    process.env.CLOUDINARY_CLOUD_NAME = 'testcloud';
    process.env.CLOUDINARY_API_KEY = '123456789012345';
    process.env.CLOUDINARY_API_SECRET = 'abcd1234';

    const mockFiles = (await fs.readdir(mocksPath)).filter(filePath => filePath.includes('.html'));
    const tempTestPath = path.join(tempPath, expect.getState().currentTestName);
    await mkdir(tempTestPath);
    await Promise.all(mockFiles.map(async file => {
      await fs.copyFile(path.join(mocksPath, file), path.join(tempTestPath, file));
    }))
  });

  afterEach(async () => {
    process.env = ENV_ORIGINAL;

    await fs.rm(path.join(tempPath, expect.getState().currentTestName), { recursive: true, force: true });
  });

  afterAll(async () => {
    await fs.rm(tempPath, { recursive: true, force: true })
  })

  describe('Build', () => {

    test('should replace with Cloudinary URLs', async () => {
      process.env.CONTEXT = 'production';
      process.env.NETLIFY_HOST = 'https://netlify-plugin-cloudinary.netlify.app';

      // Tests to ensure that delivery type of fetch works without API Key and Secret as it should

      delete process.env.CLOUDINARY_API_KEY;
      delete process.env.CLOUDINARY_API_SECRET;

      const deliveryType = 'fetch';

      const tempTestPath = path.join(tempPath, expect.getState().currentTestName);

      await onPostBuild({
        constants: {
          PUBLISH_DIR: tempTestPath
        },
        inputs: {
          deliveryType,
          folder: process.env.SITE_NAME,
        },
      });

      const files = await fs.readdir(tempTestPath);

      await Promise.all(files.map(async file => {
        const data = await fs.readFile(path.join(tempTestPath, file), 'utf-8');
        const dom = new JSDOM(data);
        const images = Array.from(dom.window.document.querySelectorAll('img'));
        images.forEach(image => {
          expect(image.getAttribute('src')).toMatch('https://res.cloudinary.com');
        })
      }));
    });

  });

  describe('Inputs', () => {

    test('should add transformations', async () => {
      process.env.CONTEXT = 'production';
      process.env.NETLIFY_HOST = 'https://netlify-plugin-cloudinary.netlify.app';

      // Tests to ensure that delivery type of fetch works without API Key and Secret as it should

      delete process.env.CLOUDINARY_API_KEY;
      delete process.env.CLOUDINARY_API_SECRET;

      const deliveryType = 'fetch';

      const tempTestPath = path.join(tempPath, expect.getState().currentTestName);

      const maxSize = {
        width: 800,
        height: 600,
        dpr: '3.0',
        crop: 'limit'
      };

      await onPostBuild({
        constants: {
          PUBLISH_DIR: tempTestPath
        },
        inputs: {
          deliveryType,
          folder: process.env.SITE_NAME,
          maxSize
        },
      });

      const files = await fs.readdir(tempTestPath);

      await Promise.all(files.map(async file => {
        const data = await fs.readFile(path.join(tempTestPath, file), 'utf-8');
        const dom = new JSDOM(data);
        const images = Array.from(dom.window.document.querySelectorAll('img'));
        images.forEach(image => {
          expect(image.getAttribute('src')).toMatch('https://res.cloudinary.com');
          expect(image.getAttribute('src')).toMatch(`f_auto,q_auto/c_${maxSize.crop},dpr_${maxSize.dpr},h_${maxSize.height},w_${maxSize.width}`);
        })
      }));
    });

  });

});
