'use strict';
const vscode = require('vscode');
const fs = require('fs');
const fsPromises = fs.promises;
const pathModule = require('path');
const sleep = require('util').promisify(setTimeout);
const lg = require('./language');

async function AddIcon(
    NameExt,
    FullNameExt,
    dirName = '',
    fileExt = '',
    dirJsonName = '',
    JsonFileName = [],
    PartPath = '') {

    const allExts = vscode.extensions.all;
    if (allExts.length < 2) return;

    const extenPath = pathModule.dirname(allExts[allExts.length - 2].extensionPath);

    let NameDir = '';
    try {
        const folders = await fsPromises.readdir(extenPath, { withFileTypes: true });
        NameDir = folders.filter((d) => d.isDirectory())
            .map((d) => d.name)
            .filter(name => name.includes(FullNameExt))
            .join();
    } catch (err) {
        // Ignore error if directory doesn't exist
    }

    try {
        vscode.extensions.getExtension(FullNameExt).extensionPath;
    }
    catch (e) {
        return NameDir === '' ?
            vscode.window.showInformationMessage(`${lg['s_i_m']} '${NameExt}'`, lg['but_text_i'])
                .then((selection) => {
                    if (selection === lg['but_text_i']) {
                        vscode.window.withProgress(
                            {
                                location: vscode.ProgressLocation.Notification,
                                title: `${lg['s_i_m_1']} '${NameExt}'`,
                            },
                            async () => {
                                await vscode.commands.executeCommand('workbench.extensions.installExtension', FullNameExt);
                                await sleep(2000);
                                await AddIcon(NameExt, FullNameExt, dirName, fileExt, dirJsonName, JsonFileName, PartPath);
                            }
                        );
                    }
                })
            : vscode.window.showWarningMessage(`'${NameExt}' ${lg['s_i_m_4']}`);
    }

    if (NameExt === 'Material Icon Theme') {
        await add_material(NameExt, extenPath);
    } else if (NameExt === 'vscode-icons') {
        await add_vsicons(NameExt, extenPath);
    } else {
        await add(dirName, fileExt, dirJsonName, JsonFileName, PartPath, NameDir, NameExt, extenPath);
    }
}

async function add(dirName, fileExt, dirJsonName, JsonFileName, PartPath, NameDir, NameExt, extenPath) {

    const files = ['mq4', 'mq5', 'ex4', 'ex5', 'mqh'];
    for (const x of files) {
        await fsPromises.copyFile(
            pathModule.join(__dirname, '../', 'files', 'icons', x + '.' + fileExt),
            pathModule.join(extenPath, NameDir, dirName, x + '.' + fileExt)
        );
    }

    for (const name of JsonFileName) {
        const jsonPath = pathModule.join(extenPath, NameDir, dirJsonName, name + '.json');
        const data = await fsPromises.readFile(jsonPath, 'utf8');

        let obj;
        try {
            obj = JSON.parse(data);
        } catch (err) {
            console.error(`[MQL Tools] Failed to parse icon configuration JSON at ${jsonPath}: ${err.message}`);
            continue; // Skip this file and continue with others
        }

        if (NameExt === 'Material Theme Icons') { dirName = dirName.split('/')[dirName.split('/').length - 1]; }
        if (NameExt === 'VSCode Great Icons') {
            Object.assign(obj.iconDefinitions,
                { _f_mq4: { iconPath: PartPath + dirName + '/mq4.' + fileExt } },
                { _f_mq5: { iconPath: PartPath + dirName + '/mq5.' + fileExt } },
                { _f_mqh: { iconPath: PartPath + dirName + '/mqh.' + fileExt } },
                { _f_ex4: { iconPath: PartPath + dirName + '/ex4.' + fileExt } },
                { _f_ex5: { iconPath: PartPath + dirName + '/ex5.' + fileExt } });

            Object.assign(obj.fileExtensions,
                { mq4: '_f_mq4' },
                { mq5: '_f_mq5' },
                { mqh: '_f_mqh' },
                { ex4: '_f_ex4' },
                { ex5: '_f_ex5' });
        } else {
            Object.assign(obj.iconDefinitions,
                { mq4: { iconPath: PartPath + dirName + '/mq4.' + fileExt } },
                { mq5: { iconPath: PartPath + dirName + '/mq5.' + fileExt } },
                { mqh: { iconPath: PartPath + dirName + '/mqh.' + fileExt } },
                { ex4: { iconPath: PartPath + dirName + '/ex4.' + fileExt } },
                { ex5: { iconPath: PartPath + dirName + '/ex5.' + fileExt } });

            Object.assign(obj.fileExtensions,
                { mq4: 'mq4' },
                { mq5: 'mq5' },
                { mqh: 'mqh' },
                { ex4: 'ex4' },
                { ex5: 'ex5' });
        }

        let json;
        try {
            json = JSON.stringify(obj, null, 4);
        } catch (err) {
            console.error(`[MQL Tools] Failed to stringify icon configuration: ${err.message}`);
            continue; // Skip this file and continue with others
        }
        await fsPromises.writeFile(jsonPath, json, 'utf8');
    }

    vscode.window.showInformationMessage(`${lg['s_i_m_2']} '${NameExt}'`);
}

async function add_material(NameExt, extenPath) {
    const config = vscode.workspace.getConfiguration(),
        folderName = 'material-icon-theme-custom-icons';

    const fullCustomPath = pathModule.join(extenPath, 'mql-tools-icons', folderName);

    // Recursive directory creation
    await fsPromises.mkdir(fullCustomPath, { recursive: true });

    const icons = ['mq4.svg', 'mq5.svg', 'ex4.svg', 'ex5.svg', 'mqh.svg'];
    for (const x of icons) {
        await fsPromises.copyFile(
            pathModule.join(__dirname, '../', 'files', 'icons', x),
            pathModule.join(fullCustomPath, x)
        );
    }

    let obj = {
        '*.ex4': `../../mql-tools-icons/${folderName}/ex4`,
        '*.ex5': `../../mql-tools-icons/${folderName}/ex5`,
        '*.mq4': `../../mql-tools-icons/${folderName}/mq4`,
        '*.mq5': `../../mql-tools-icons/${folderName}/mq5`,
        '*.mqh': `../../mql-tools-icons/${folderName}/mqh`,
    };

    config.update('material-icon-theme.files.associations', obj, true);

    vscode.window.showInformationMessage(`${lg['s_i_m_2']} '${NameExt}'`);
}

async function add_vsicons(NameExt, extenPath) {
    const config = vscode.workspace.getConfiguration(),
        folderName = 'vsicons-custom-icons';

    const fullCustomPath = pathModule.join(extenPath, 'mql-tools-icons', folderName);
    await fsPromises.mkdir(fullCustomPath, { recursive: true });

    const icons = ['mq4.svg', 'mq5.svg', 'ex4.svg', 'ex5.svg', 'mqh.svg'];
    for (const x of icons) {
        await fsPromises.copyFile(
            pathModule.join(__dirname, '../', 'files', 'icons', x),
            pathModule.join(fullCustomPath, 'file_type_' + x)
        );
    }

    let obj = [
        { 'icon': 'mq4', 'extensions': ['mq4'], 'format': 'svg' },
        { 'icon': 'mq5', 'extensions': ['mq5'], 'format': 'svg' },
        { 'icon': 'mqh', 'extensions': ['mqh'], 'format': 'svg' },
        { 'icon': 'ex4', 'extensions': ['ex4'], 'format': 'svg' },
        { 'icon': 'ex5', 'extensions': ['ex5'], 'format': 'svg' }
    ];

    config.update('vsicons.customIconFolderPath', pathModule.join(extenPath, 'mql-tools-icons'), true);
    config.update('vsicons.associations.files', obj, true);

    vscode.window.showInformationMessage(`${lg['s_i_m_2']} '${NameExt}'`);
}

function installIcons() {
    const theme1 = 'Material Icon Theme', theme2 = 'vscode-icons', theme3 = 'VSCode Great Icons', theme4 = 'Material Theme Icons', options = [
        {
            label: theme1,
            volume: 0
        },
        {
            label: theme2,
            volume: 1
        },
        {
            label: theme3,
            volume: 2
        },
        {
            label: theme4,
            volume: 3
        },
    ];

    vscode.window.showQuickPick(options, { placeHolder: lg['s_i_t'] }).then((item) => {
        if (!item)
            return undefined;

        switch (item.volume) {
            case 0: AddIcon(
                theme1,
                'pkief.material-icon-theme'
            );
                break;
            case 1: AddIcon(
                theme2,
                'vscode-icons-team.vscode-icons'
            );
                break;
            case 2: AddIcon(
                theme3,
                'emmanuelbeziat.vscode-great-icons',
                'icons',
                'png',
                '',
                [
                    'icons'
                ],
                './'
            );
                break;

            case 3: AddIcon(
                theme4,
                'equinusocio.vsc-material-theme-icons',
                'out/icons',
                'svg',
                'out/variants',
                [
                    'Material-Theme-Icons',
                    'Material-Theme-Icons-Darker',
                    'Material-Theme-Icons-Light',
                    'Material-Theme-Icons-Ocean',
                    'Material-Theme-Icons-Palenight',
                ],
                '../'
            );
                break;
        }
    });
}

module.exports = {
    installIcons
};