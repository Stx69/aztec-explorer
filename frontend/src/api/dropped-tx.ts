import {
  type ChicmozL2DroppedTx,
  chicmozL2DroppedTxSchema,
} from "@chicmoz-pkg/types";
import { aztecExplorer } from "~/service/constants";
import client, { validateResponse } from "./client";

export const DroppedTxAPI = {
  getDroppedTxByHash: async (
    hash: string,
  ): Promise<ChicmozL2DroppedTx | null> => {
    const response = await client.get(
      aztecExplorer.getL2DroppedTxByHash(hash),
    );
    if (response.data?.absent === true) return null;
    return validateResponse(chicmozL2DroppedTxSchema, response.data);
  },
};
