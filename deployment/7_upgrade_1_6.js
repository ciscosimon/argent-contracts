const semver = require("semver");
const childProcess = require("child_process");
const ApprovedTransfer = require("../build/ApprovedTransfer");
const RecoveryManager = require("../build/RecoveryManager");
const MultiSig = require("../build/MultiSigWallet");
const ModuleRegistry = require("../build/ModuleRegistry");
const Upgrader = require("../build/SimpleUpgrader");
const DeployManager = require("../utils/deploy-manager.js");
const MultisigExecutor = require("../utils/multisigexecutor.js");
const TokenPriceProvider = require("../build/TokenPriceProvider");
const MakerRegistry = require("../build/MakerRegistry");
const ScdMcdMigration = require("../build/ScdMcdMigration");
const MakerV2Manager = require("../build/MakerV2Manager");
const TransferManager = require("../build/TransferManager");

const utils = require("../utils/utilities.js");

const TARGET_VERSION = "1.6.0";
const MODULES_TO_ENABLE = ["ApprovedTransfer", "RecoveryManager", "MakerV2Manager", "TransferManager"];
const MODULES_TO_DISABLE = ["UniswapManager"];

const BACKWARD_COMPATIBILITY = 1;

const deploy = async (network) => {
  if (!["kovan", "kovan-fork", "staging", "prod"].includes(network)) {
    console.warn("------------------------------------------------------------------------");
    console.warn(`WARNING: The MakerManagerV2 module is not fully functional on ${network}`);
    console.warn("------------------------------------------------------------------------");
  }

  const newModuleWrappers = [];
  const newVersion = {};

  // //////////////////////////////////
  // Setup
  // //////////////////////////////////

  const manager = new DeployManager(network);
  await manager.setup();

  const { configurator } = manager;
  const { deployer } = manager;
  const { abiUploader } = manager;
  const { versionUploader } = manager;
  const { gasPrice } = deployer.defaultOverrides;
  const deploymentWallet = deployer.signer;
  const { config } = configurator;

  const ModuleRegistryWrapper = await deployer.wrapDeployedContract(ModuleRegistry, config.contracts.ModuleRegistry);
  const MultiSigWrapper = await deployer.wrapDeployedContract(MultiSig, config.contracts.MultiSigWallet);
  const multisigExecutor = new MultisigExecutor(MultiSigWrapper, deploymentWallet, config.multisig.autosign, { gasPrice });

  // //////////////////////////////////
  // Deploy infrastructure contracts
  // //////////////////////////////////

  // Deploy and configure Maker Registry
  const ScdMcdMigrationWrapper = await deployer.wrapDeployedContract(ScdMcdMigration, config.defi.maker.migration);
  const vatAddress = await ScdMcdMigrationWrapper.vat();
  const MakerRegistryWrapper = await deployer.deploy(MakerRegistry, {}, vatAddress);
  const wethJoinAddress = await ScdMcdMigrationWrapper.wethJoin();
  const addCollateralTransaction = await MakerRegistryWrapper.contract.addCollateral(wethJoinAddress, { gasPrice });
  await MakerRegistryWrapper.verboseWaitForTransaction(addCollateralTransaction, `Adding join adapter ${wethJoinAddress} to the MakerRegistry`);
  const changeMakerRegistryOwnerTx = await MakerRegistryWrapper.contract.changeOwner(config.contracts.MultiSigWallet, { gasPrice });
  await MakerRegistryWrapper.verboseWaitForTransaction(changeMakerRegistryOwnerTx, "Set the MultiSig as the owner of the MakerRegistry");
  const TokenPriceProviderWrapper = await deployer.wrapDeployedContract(TokenPriceProvider, config.contracts.TokenPriceProvider);

  // //////////////////////////////////
  // Deploy new modules
  // //////////////////////////////////

  const ApprovedTransferWrapper = await deployer.deploy(
    ApprovedTransfer,
    {},
    config.contracts.ModuleRegistry,
    config.modules.GuardianStorage,
  );
  newModuleWrappers.push(ApprovedTransferWrapper);

  const RecoveryManagerWrapper = await deployer.deploy(
    RecoveryManager,
    {},
    config.contracts.ModuleRegistry,
    config.modules.GuardianStorage,
    config.settings.recoveryPeriod || 0,
    config.settings.lockPeriod || 0,
    config.settings.securityPeriod || 0,
    config.settings.securityWindow || 0,
  );
  newModuleWrappers.push(RecoveryManagerWrapper);

  const MakerV2ManagerWrapper = await deployer.deploy(
    MakerV2Manager,
    {},
    config.contracts.ModuleRegistry,
    config.modules.GuardianStorage,
    config.defi.maker.migration,
    config.defi.maker.pot,
    config.defi.maker.jug,
    MakerRegistryWrapper.contractAddress,
    config.defi.uniswap.factory,
  );
  newModuleWrappers.push(MakerV2ManagerWrapper);

  const TransferManagerWrapper = await deployer.deploy(
    TransferManager,
    {},
    config.contracts.ModuleRegistry,
    config.modules.TransferStorage,
    config.modules.GuardianStorage,
    TokenPriceProviderWrapper.contractAddress,
    config.settings.securityPeriod || 0,
    config.settings.securityWindow || 0,
    config.settings.defaultLimit || "1000000000000000000",
    ["test", "staging", "prod"].includes(network) ? config.modules.TransferManager : "0x0000000000000000000000000000000000000000",
  );
  newModuleWrappers.push(TransferManagerWrapper);

  // /////////////////////////////////////////////////
  // Update config and Upload ABIs
  // /////////////////////////////////////////////////

  configurator.updateModuleAddresses({
    ApprovedTransfer: ApprovedTransferWrapper.contractAddress,
    RecoveryManager: RecoveryManagerWrapper.contractAddress,
    MakerV2Manager: MakerV2ManagerWrapper.contractAddress,
    TransferManager: TransferManagerWrapper.contractAddress,
  });

  configurator.updateInfrastructureAddresses({
    MakerRegistry: MakerRegistryWrapper.contractAddress,
  });

  const gitHash = childProcess.execSync("git rev-parse HEAD").toString("utf8").replace(/\n$/, "");
  configurator.updateGitHash(gitHash);
  await configurator.save();

  await Promise.all([
    abiUploader.upload(ApprovedTransferWrapper, "modules"),
    abiUploader.upload(RecoveryManagerWrapper, "modules"),
    abiUploader.upload(MakerV2ManagerWrapper, "modules"),
    abiUploader.upload(TransferManagerWrapper, "modules"),
    abiUploader.upload(MakerRegistryWrapper, "contracts"),
  ]);

  // //////////////////////////////////
  // Register new modules
  // //////////////////////////////////

  for (let idx = 0; idx < newModuleWrappers.length; idx += 1) {
    const wrapper = newModuleWrappers[idx];
    await multisigExecutor.executeCall(ModuleRegistryWrapper, "registerModule",
      [wrapper.contractAddress, utils.asciiToBytes32(wrapper._contract.contractName)]);
  }

  // //////////////////////////////////
  // Deploy and Register upgraders
  // //////////////////////////////////


  let fingerprint;
  const versions = await versionUploader.load(BACKWARD_COMPATIBILITY);
  for (let idx = 0; idx < versions.length; idx += 1) {
    const version = versions[idx];
    let toAdd; let
      toRemove;
    if (idx === 0) {
      const moduleNamesToRemove = MODULES_TO_DISABLE.concat(MODULES_TO_ENABLE);
      toRemove = version.modules.filter((module) => moduleNamesToRemove.includes(module.name));
      toAdd = newModuleWrappers.map((wrapper) => ({
        address: wrapper.contractAddress,
        name: wrapper._contract.contractName,
      }));
      const toKeep = version.modules.filter((module) => !moduleNamesToRemove.includes(module.name));
      const modulesInNewVersion = toKeep.concat(toAdd);
      fingerprint = utils.versionFingerprint(modulesInNewVersion);
      newVersion.version = semver.lt(version.version, TARGET_VERSION) ? TARGET_VERSION : semver.inc(version.version, "patch");
      newVersion.createdAt = Math.floor((new Date()).getTime() / 1000);
      newVersion.modules = modulesInNewVersion;
      newVersion.fingerprint = fingerprint;
    } else {
      // add all modules present in newVersion that are not present in version
      toAdd = newVersion.modules.filter((module) => !version.modules.map((m) => m.address).includes(module.address));
      // remove all modules from version that are no longer present in newVersion
      toRemove = version.modules.filter((module) => !newVersion.modules.map((m) => m.address).includes(module.address));
    }

    const upgraderName = `${version.fingerprint}_${fingerprint}`;

    const UpgraderWrapper = await deployer.deploy(
      Upgrader,
      {},
      config.contracts.ModuleRegistry,
      toRemove.map((module) => module.address),
      toAdd.map((module) => module.address),
    );
    await multisigExecutor.executeCall(ModuleRegistryWrapper, "registerModule",
      [UpgraderWrapper.contractAddress, utils.asciiToBytes32(upgraderName)]);

    await multisigExecutor.executeCall(ModuleRegistryWrapper, "registerUpgrader",
      [UpgraderWrapper.contractAddress, utils.asciiToBytes32(upgraderName)]);
  }

  // //////////////////////////////////
  // Upload Version
  // //////////////////////////////////

  await versionUploader.upload(newVersion);
};


module.exports = {
  deploy,
};
