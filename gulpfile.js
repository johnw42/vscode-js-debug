/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

const del = require('del');
const filter = require('gulp-filter');
const gulp = require('gulp');
const minimist = require('minimist');
const path = require('path');
const sourcemaps = require('gulp-sourcemaps');
const tsb = require('gulp-tsb');
const rename = require('gulp-rename');
const merge = require('merge2');
const vsce = require('vsce');
const webpack = require('webpack');
const execSync = require('child_process').execSync;
const fs = require('fs');
const cp = require('child_process');
const util = require('util');
const deepmerge = require('deepmerge');
const unzipper = require('unzipper');
const signale = require('signale');
const streamBuffers = require('stream-buffers');
const got = require('got').default;
const execa = require('execa');

const dirname = 'js-debug';
const sources = ['src/**/*.{ts,tsx}'];
const allPackages = [];

const buildDir = 'out';
const buildSrcDir = `${buildDir}/src`;
const distDir = 'dist';
const distSrcDir = `${distDir}/src`;
const nodeTargetsDir = `targets/node`;

/**
 * Whether we're running a nightly build.
 */
const isNightly = process.argv.includes('--nightly') || process.argv.includes('watch');

/**
 * Extension ID to build. Appended with '-nightly' as necessary.
 */
const extensionName = isNightly ? 'js-debug-nightly' : 'js-debug';

function runBuildScript(name) {
  return new Promise((resolve, reject) =>
    cp.execFile(
      process.execPath,
      [path.join(__dirname, 'out', 'src', 'build', name)],
      (err, stdout, stderr) => {
        process.stderr.write(stderr);
        if (err) {
          return reject(err);
        }

        const outstr = stdout.toString('utf-8');
        try {
          resolve(JSON.parse(outstr));
        } catch {
          resolve(outstr);
        }
      },
    ),
  );
}

const writeFile = util.promisify(fs.writeFile);
const readFile = util.promisify(fs.readFile);

async function readJson(file) {
  const contents = await readFile(path.join(__dirname, file), 'utf-8');
  return JSON.parse(contents);
}

const tsProject = tsb.create('./tsconfig.json');

gulp.task('clean-assertions', () => del(['src/test/**/*.txt.actual']));

gulp.task('clean', () =>
  del(['out/**', 'dist/**', 'src/*/package.nls.*.json', 'packages/**', '*.vsix']),
);

gulp.task('compile:ts', () =>
  tsProject
    .src()
    .pipe(sourcemaps.init())
    .pipe(tsProject())
    .pipe(
      sourcemaps.write('.', {
        includeContent: false,
        sourceRoot: '../../src',
      }),
    )
    .pipe(gulp.dest(buildSrcDir)),
);

async function fixNightlyReadme() {
  const readmePath = `${buildDir}/README.md`;
  const readmeText = await readFile(readmePath);
  const readmeNightlyText = await readFile(`README.nightly.md`);

  await writeFile(readmePath, readmeNightlyText + '\n' + readmeText);
}

const getVersionNumber = () => {
  if (process.env.JS_DEBUG_VERSION) {
    return process.env.JS_DEBUG_VERSION;
  }

  const date = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const monthMinutes = (date.getDate() - 1) * 24 * 60 + date.getHours() * 60 + date.getMinutes();

  return [
    // YY
    date.getFullYear(),
    // MM,
    date.getMonth() + 1,
    //DDHH
    `${date.getDate()}${String(date.getHours()).padStart(2, '0')}`,
  ].join('.');
};

gulp.task('compile:dynamic', async () => {
  const [contributions, strings] = await Promise.all([
    runBuildScript('generate-contributions'),
    runBuildScript('generate-strings'),
    runBuildScript('documentReadme'),
  ]);

  let packageJson = await readJson(`${buildDir}/package.json`);
  packageJson.name = extensionName;
  if (isNightly) {
    packageJson.displayName += ' (Nightly)';
    packageJson.version = getVersionNumber();
    packageJson.preview = true;
    await fixNightlyReadme();
  }

  packageJson = deepmerge(packageJson, contributions);

  return Promise.all([
    writeFile(`${buildDir}/package.json`, JSON.stringify(packageJson, null, 2)),
    writeFile(`${buildDir}/package.nls.json`, JSON.stringify(strings, null, 2)),
  ]);
});

gulp.task('compile:static', () =>
  merge(
    gulp.src(['LICENSE', 'package.json']),
    gulp.src(['resources/**/*', 'README.md', 'src/**/*.sh'], { base: '.' }),
  ).pipe(gulp.dest(buildDir)),
);

/** Compiles supporting libraries to single bundles in the output */
gulp.task(
  'compile:webpack-supporting',
  gulp.parallel(
    () => runWebpack({ devtool: 'source-map', compileInPlace: true }),
    () =>
      gulp
        .src('node_modules/@c4312/chromehash/pkg/*.wasm')
        .pipe(gulp.dest(`${buildSrcDir}/common/hash`)),
  ),
);

gulp.task(
  'compile',
  gulp.series('compile:ts', 'compile:static', 'compile:dynamic', 'compile:webpack-supporting'),
);

async function runWebpack({
  packages = [],
  devtool = false,
  compileInPlace = false,
  mode = process.argv.includes('watch') ? 'development' : 'production',
  watch = false,
} = options) {
  // add the entrypoints common to both vscode and vs here
  packages = [
    ...packages,
    { entry: `${buildSrcDir}/common/hash/hash.js`, library: false },
    { entry: `${buildSrcDir}/${nodeTargetsDir}/bootloader.js`, library: false },
    { entry: `${buildSrcDir}/${nodeTargetsDir}/watchdog.js`, library: false },
    { entry: `${buildSrcDir}/diagnosticTool/diagnosticTool.js`, library: false, target: 'web' },
  ];

  let todo = [];
  for (const { entry, target, library, filename, isInExtension } of packages) {
    const config = {
      mode,
      target: target || 'async-node',
      entry: path.resolve(entry),
      output: {
        path: compileInPlace ? path.resolve(path.dirname(entry)) : path.resolve(distSrcDir),
        filename: filename || path.basename(entry).replace('.js', '.bundle.js'),
        devtoolModuleFilenameTemplate: '../[resource-path]',
      },
      devtool: devtool,
      resolve: {
        extensions: isInExtension ? ['.js', '.json'] : ['.js', '.json'],
        alias: {
          // their .mjs seems broken:
          acorn: require.resolve('acorn'),
          'acorn-loose': require.resolve('acorn-loose'),
        },
        fallback: { path: require.resolve('path-browserify') },
      },
      module: {
        rules: [
          {
            test: '\\.node$', // will be regex'd in the webpackBuild script
            loader: 'node-loader',
          },
          {
            test: '\\.css$', // will be regex'd in the webpackBuild script
            use: ['style-loader', 'css-loader'],
          },
        ],
      },
      plugins: [],
      node: {
        __dirname: false,
        __filename: false,
      },
      externals: {
        vscode: 'commonjs vscode',
      },
    };

    if (library) {
      config.output.libraryTarget = 'commonjs2';
    }

    if (isInExtension) {
      config.resolve.alias['@vscode/l10n'] = path.resolve(
        __dirname,
        `${buildSrcDir}/common/l10n.extensionOnly.js`,
      );
    }

    todo.push(
      execa('node', [path.join(__dirname, 'src/build/webpackBuild')], {
        stdio: 'inherit',
        env: {
          ...process.env,
          CONFIG: JSON.stringify(config),
          ANALYZE_SIZE: String(process.argv.includes('--analyze-size')),
          WATCH: String(watch),
          USE_VSCODE_L10N: Boolean(isInExtension),
        },
      }),
    );
  }

  await Promise.all(todo);
}

/** Run webpack to bundle the extension output files */
gulp.task('package:webpack-bundle', async () => {
  const packages = [
    {
      entry: `${buildSrcDir}/extension.js`,
      filename: 'extension.js',
      library: true,
      isInExtension: true,
    },
  ];
  return runWebpack({ packages });
});

/** Run webpack to bundle into the flat session launcher (for VS or standalone debug server)  */
gulp.task('flatSessionBundle:webpack-bundle', async () => {
  const packages = [{ entry: `${buildSrcDir}/flatSessionLauncher.js`, library: true }];
  return runWebpack({ packages, devtool: 'nosources-source-map' });
});

gulp.task('package:bootloader-as-cdp', done => {
  const bootloaderFilePath = path.resolve(distSrcDir, 'bootloader.bundle.js');
  fs.appendFile(bootloaderFilePath, '\n//# sourceURL=bootloader.bundle.cdp', done);
});

/** Run webpack to bundle into the VS debug server */
gulp.task('vsDebugServerBundle:webpack-bundle', async () => {
  const packages = [{ entry: `${buildSrcDir}/vsDebugServer.js`, library: true }];
  return runWebpack({ packages, devtool: 'nosources-source-map' });
});

/** Copy the extension static files */
gulp.task('package:copy-extension-files', () =>
  merge(
    gulp.src(
      [
        `${buildDir}/LICENSE`,
        `${buildDir}/package.json`,
        `${buildDir}/package.*.json`,
        `${buildDir}/resources/**/*`,
        `${buildDir}/README.md`,
      ],
      {
        base: buildDir,
      },
    ),
    gulp
      .src(['node_modules/source-map/lib/*.wasm', 'node_modules/@c4312/chromehash/pkg/*.wasm'])
      .pipe(rename({ dirname: 'src' })),
    gulp.src(`${buildDir}/src/**/*.sh`).pipe(rename({ dirname: 'src' })),
  ).pipe(gulp.dest(distDir)),
);

const vsceUrls = {
  baseContentUrl: 'https://github.com/microsoft/vscode-js-debug/blob/main',
  baseImagesUrl: 'https://github.com/microsoft/vscode-js-debug/raw/main',
};

/** Create a VSIX package using the vsce command line tool */
gulp.task('package:createVSIX', () =>
  vsce.createVSIX({
    ...vsceUrls,
    cwd: distDir,
    useYarn: true,
    packagePath: path.join(distDir, `${extensionName}.vsix`),
  }),
);

/** Clean, compile, bundle, and create vsix for the extension */
gulp.task(
  'package:prepare',
  gulp.series(
    'clean',
    'compile:ts',
    'compile:static',
    'compile:dynamic',
    'package:webpack-bundle',
    'package:bootloader-as-cdp',
    'package:copy-extension-files',
    'package:createVSIX',
  ),
);

gulp.task('package', gulp.series('package:prepare', 'package:createVSIX'));

gulp.task(
  'flatSessionBundle',
  gulp.series(
    'clean',
    'compile',
    'flatSessionBundle:webpack-bundle',
    'package:bootloader-as-cdp',
    'package:copy-extension-files',
  ),
);

// for now, this task will build both flat session and debug server until we no longer need flat session
gulp.task(
  'vsDebugServerBundle',
  gulp.series(
    'clean',
    'compile',
    'vsDebugServerBundle:webpack-bundle',
    'flatSessionBundle:webpack-bundle',
    'package:bootloader-as-cdp',
    'package:copy-extension-files',
  ),
);

/** Publishes the build extension to the marketplace */
gulp.task('publish:vsce', () =>
  vsce.publish({
    ...vsceUrls,
    noVerify: true, // for proposed API usage
    pat: process.env.MARKETPLACE_TOKEN,
    useYarn: true,
    cwd: distDir,
  }),
);

gulp.task('publish', gulp.series('package', 'publish:vsce'));
gulp.task('default', gulp.series('compile'));

gulp.task(
  'watch',
  gulp.series('clean', 'compile', done => {
    gulp.watch(
      [...sources, '*.json'],
      gulp.series('compile:ts', 'compile:static', 'compile:dynamic'),
    );
    runWebpack({ watch: true, devtool: 'source-map', compileInPlace: true });
    done();
  }),
);

const runPrettier = (onlyStaged, fix, callback) => {
  const child = cp.fork(
    './node_modules/@mixer/parallel-prettier/dist/index.js',
    [fix ? '--write' : '--list-different', 'src/**/*.{ts,tsx}', '!src/**/*.d.ts', '*.md'],
    { stdio: 'inherit' },
  );

  child.on('exit', code => (code ? callback(`Prettier exited with code ${code}`) : callback()));
};

const runEslint = (fix, callback) => {
  const child = cp.fork(
    './node_modules/eslint/bin/eslint.js',
    ['--color', 'src/**/*.ts', fix ? '--fix' : ['--max-warnings=0']],
    { stdio: 'inherit' },
  );

  child.on('exit', code => (code ? callback(`Eslint exited with code ${code}`) : callback()));
};

gulp.task('format:prettier', callback => runPrettier(false, true, callback));
gulp.task('format:eslint', callback => runEslint(true, callback));
gulp.task('format', gulp.series('format:prettier', 'format:eslint'));

gulp.task('lint:prettier', callback => runPrettier(false, false, callback));
gulp.task('lint:eslint', callback => runEslint(false, callback));
gulp.task('lint', gulp.parallel('lint:prettier', 'lint:eslint'));

/**
 * Run a command in the terminal using exec, and wrap it in a promise
 * @param {string} cmd The command line command + args to execute
 * @param {ExecOptions} options, see here for options: https://nodejs.org/docs/latest-v10.x/api/child_process.html#child_process_child_process_exec_command_options_callback
 */
function runCommand(cmd, options) {
  return new Promise((resolve, reject) => {
    let execError = undefined;
    try {
      execSync(cmd, { stdio: 'inherit', ...options });
    } catch (err) {
      reject(err);
    }
    resolve();
  });
}
