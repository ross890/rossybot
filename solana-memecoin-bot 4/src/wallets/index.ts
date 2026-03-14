// ===========================================
// ALPHA WALLET ENGINE — MODULE INDEX
// ===========================================

export { walletEngine, WalletEngine } from './walletEngine.js';
export type { EngineWallet, EngineObservation } from './walletEngine.js';
export { gmgnDiscovery, GmgnDiscovery } from './gmgnDiscovery.js';
export { walletGraduation, WalletGraduation } from './walletGraduation.js';
export { walletPerformanceManager, WalletPerformanceManager } from './walletPerformance.js';
export { onchainDiscovery, OnchainDiscovery } from './onchainDiscovery.js';
export { coTraderDiscovery, CoTraderDiscovery } from './coTraderDiscovery.js';

// Nansen integration modules
export { nansenWalletDiscovery, NansenWalletDiscovery } from '../nansen/nansenWalletDiscovery.js';
export { nansenWinnerScanner, NansenWinnerScanner } from '../nansen/nansenWinnerScanner.js';
export { nansenWalletRefresh, NansenWalletRefresh } from '../nansen/nansenWalletRefresh.js';
export { nansenAlertReceiver, NansenAlertReceiver } from '../nansen/nansenAlertReceiver.js';
export { nansenClient } from '../nansen/nansenClient.js';
export { enrichWithNansenFlows, calculateNansenFlowBonus, enrichWithTimeout } from '../nansen/tokenFlowEnrichment.js';
export type { NansenFlowData } from '../nansen/tokenFlowEnrichment.js';
