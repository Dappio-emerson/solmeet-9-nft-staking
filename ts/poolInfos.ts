import BN from "bn.js";
import * as anchor from "@project-serum/anchor";
import {
  PublicKey,
  MemcmpFilter,
  GetProgramAccountsConfig,
  DataSizeFilter,
} from "@solana/web3.js";
import { hex } from "@project-serum/anchor/dist/cjs/utils/bytes";
import { hash } from "@project-serum/anchor/dist/cjs/utils/sha256";
import { NFT_RARITY_PROGRAM_ID, NFT_STAKING_PROGRAM_ID } from "./ids";
import { find } from "lodash";
import { findAssociatedTokenAddress } from "./utils";
import { IDL as nftStakingIDL } from "../target/types/nft_staking";
import { IDL as nftRarityIDL } from "../target/types/nft_rarity";

const RARITY_INFO_SEED = "rarity_info";
const POOL_INFO_SEED = "pool_info";
const PROVE_TOKEN_VAULT_SEED = "prove_token_vault";
const FARM_INFO_SEED = "farm-info";
const MINING_VAULT_SEED = "vault";
const MINING_TOKEN_SEED = "mining-token";

export class RarityInfo {
  constructor(
    public key: PublicKey, // can be generated by findKeyAndSeed() by providing nonce
    public admin: PublicKey,
    public collection: string,
    public rarity: string,
    public mintList: PublicKey[],
    public nonce?: number,
    public seed?: string
  ) {}

  async findNonceAndSeed() {
    const MAX_RANGE = 100;
    let nonce: number;
    let SEED: string;
    for (let index = 0; index <= MAX_RANGE; index++) {
      SEED = hex.encode(
        Buffer.from(this.collection + this.rarity + index + RARITY_INFO_SEED)
      );
      SEED = hash(SEED.substring(2));

      const rarityInfoKey = await PublicKey.createWithSeed(
        this.admin,
        SEED.substring(0, 32),
        NFT_RARITY_PROGRAM_ID
      );
      if (rarityInfoKey.equals(this.key)) {
        nonce = index;
        break;
      }
      if (index == MAX_RANGE) {
        return console.error("ERROR: Failed to find nonce for rarityInfo");
      }
    }
    this.nonce = nonce;
    this.seed = SEED;
  }

  async findKeyAndSeed() {
    if (this.nonce == undefined || this.nonce == null) {
      return console.error("nonce should not be undefined or null");
    }
    let SEED = hex.encode(
      Buffer.from(this.collection + this.rarity + this.nonce + RARITY_INFO_SEED)
    );
    SEED = hash(SEED.substring(2));

    const rarityInfoKey = await PublicKey.createWithSeed(
      this.admin,
      SEED.substring(0, 32),
      NFT_RARITY_PROGRAM_ID
    );

    this.key = rarityInfoKey;
    this.seed = SEED;
  }
}

export class PoolInfo {
  constructor(
    public key: PublicKey, // can be generated by findKeyAndAuthorityAndVault
    public admin: PublicKey,
    public proveTokenMint: PublicKey,
    public rarityInfo: PublicKey,
    public proveTokenAuthority?: PublicKey,
    public proveTokenVault?: PublicKey,
    public totalStakedAmount?: number
  ) {}

  async findKeyAndAuthorityAndVault() {
    const poolInfoKey = (
      await PublicKey.findProgramAddress(
        [this.rarityInfo.toBuffer(), Buffer.from(POOL_INFO_SEED)],
        NFT_STAKING_PROGRAM_ID
      )
    )[0];

    const proveTokenAuthority = (
      await PublicKey.findProgramAddress(
        [poolInfoKey.toBuffer(), Buffer.from(PROVE_TOKEN_VAULT_SEED)],
        NFT_STAKING_PROGRAM_ID
      )
    )[0];

    const proveTokenVault = await findAssociatedTokenAddress(
      proveTokenAuthority,
      this.proveTokenMint
    );

    this.key = poolInfoKey;
    this.proveTokenAuthority = proveTokenAuthority;
    this.proveTokenVault = proveTokenVault;
  }
}

export class AllInfo {
  constructor(public rarityInfo: RarityInfo, public poolInfo: PoolInfo) {}
}

export interface infoAndNftPair {
  allInfo: AllInfo;
  allInfoIndex: number;
  nftMint: PublicKey;
}

export async function fetchAll(
  provider: anchor.Provider,
  adminKey?: PublicKey
) {
  const nftStakingProgram = new anchor.Program(
    nftStakingIDL,
    NFT_STAKING_PROGRAM_ID,
    provider
  );
  const nftRarityProgram = new anchor.Program(
    nftRarityIDL,
    NFT_RARITY_PROGRAM_ID,
    provider
  );

  let adminIdMemcmp: MemcmpFilter;
  if (adminKey != null && adminKey != undefined) {
    adminIdMemcmp = {
      memcmp: {
        offset: 8,
        bytes: adminKey.toString(),
      },
    };
  }

  const poolInfoSizeFilter: DataSizeFilter = {
    dataSize: nftStakingProgram.account.poolInfo.size,
  };
  let filters: (anchor.web3.MemcmpFilter | anchor.web3.DataSizeFilter)[] = [
    poolInfoSizeFilter,
  ];
  if (adminKey != null && adminKey != undefined) {
    filters = [poolInfoSizeFilter, adminIdMemcmp];
  }
  // console.log("fetch pool infos");
  const allPoolInfos = await nftStakingProgram.account.poolInfo.all(filters);

  // const rarityInfoSizeFilter: DataSizeFilter = {
  //   dataSize: nftRarityProgram.account.rarityInfo.size,
  // };
  // filters = [rarityInfoSizeFilter];
  filters = [];
  if (adminKey != null && adminKey != undefined) {
    filters = [adminIdMemcmp];
  }
  // console.log("fetch rarity infos");
  const allRarityInfos = await nftRarityProgram.account.rarityInfo.all(filters);

  const allInfos: AllInfo[] = [];
  for (let currentRarityInfo of allRarityInfos) {
    for (let currentPoolInfo of allPoolInfos) {
      if (
        currentRarityInfo.publicKey.equals(currentPoolInfo.account.rarityInfo)
      ) {
        const rarityInfo = new RarityInfo(
          currentRarityInfo.publicKey,
          currentRarityInfo.account.admin,
          Buffer.from(currentRarityInfo.account.collection)
            .toString("utf-8")
            .split("\x00")[0],
          Buffer.from(currentRarityInfo.account.rarity)
            .toString("utf-8")
            .split("\x00")[0],
          currentRarityInfo.account.mintList
        );

        const poolInfo = new PoolInfo(
          currentPoolInfo.publicKey,
          currentPoolInfo.account.admin,
          currentPoolInfo.account.proveTokenMint,
          rarityInfo.key,
          currentPoolInfo.account.proveTokenAuthority,
          currentPoolInfo.account.proveTokenVault,
          Number(currentPoolInfo.account.totalLocked)
        );

        allInfos.push(new AllInfo(rarityInfo, poolInfo));
        break;
      }
    }
  }

  return allInfos;
}

export function infoAndNftMatcher(allInfos: AllInfo[], nftMint: PublicKey[]) {
  let pairResult: infoAndNftPair[] = [];
  for (let mint of nftMint) {
    for (let [index, allInfo] of allInfos.entries()) {
      if (
        find(allInfo.rarityInfo.mintList, (allowedMint) =>
          allowedMint.equals(mint)
        )
      ) {
        pairResult.push({
          allInfo: allInfo,
          allInfoIndex: index,
          nftMint: mint,
        });
        break;
      }
    }
  }

  return pairResult;
}

export function getStakedPercentage(
  allInfos: AllInfo[],
  collection: string = "",
  rarity: string = ""
) {
  let total = 0;
  let staked = 0;
  for (let allInfo of allInfos) {
    if (allInfo.rarityInfo.collection == collection || collection == "") {
      if (allInfo.rarityInfo.rarity == rarity || rarity == "") {
        total += allInfo.rarityInfo.mintList.length;
        staked += allInfo.poolInfo.totalStakedAmount;
      }
    }
  }
  return staked / total;
}

export function getStakedAmount(
  allInfos: AllInfo[],
  collection: string = "",
  rarity: string = ""
) {
  let staked = 0;
  for (let allInfo of allInfos) {
    if (allInfo.rarityInfo.collection == collection || collection == "") {
      if (allInfo.rarityInfo.rarity == rarity || rarity == "") {
        staked += allInfo.poolInfo.totalStakedAmount;
      }
    }
  }
  return staked;
}

export function getAllInfoFromPoolInfoKey(
  allInfos: AllInfo[],
  poolInfoKey: PublicKey
) {
  let targetInfo: AllInfo;
  for (let allInfo of allInfos) {
    if (allInfo.poolInfo.key.equals(poolInfoKey)) {
      targetInfo = allInfo;
      break;
    }
  }
  return targetInfo;
}

export async function getRarityInfoAddress(
  wallet: PublicKey,
  collection: string,
  rarity: string,
  nonce: number
) {
  let SEED = hex.encode(
    Buffer.from(collection + rarity + nonce + RARITY_INFO_SEED)
  );
  SEED = hash(SEED.substring(2));

  return await PublicKey.createWithSeed(
    wallet,
    SEED.substring(0, 32),
    NFT_RARITY_PROGRAM_ID
  );
}
