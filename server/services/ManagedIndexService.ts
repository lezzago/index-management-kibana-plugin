/*
 * Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License").
 * You may not use this file except in compliance with the License.
 * A copy of the License is located at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * or in the "license" file accompanying this file. This file is distributed
 * on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either
 * express or implied. See the License for the specific language governing
 * permissions and limitations under the License.
 */

import _ from "lodash";
import { Legacy } from "kibana";
import { RequestParams } from "@elastic/elasticsearch";
import { CLUSTER, INDEX } from "../utils/constants";
import { getMustQuery, transformManagedIndexMetaData } from "../utils/helpers";
import {
  ChangePolicyResponse,
  ExplainResponse,
  GetManagedIndicesResponse,
  RemovePolicyResponse,
  RemoveResponse,
  RetryManagedIndexResponse,
  RetryParams,
  RetryResponse,
  SearchResponse,
} from "../models/interfaces";
import { ManagedIndicesSort, ServerResponse } from "../models/types";

type Request = Legacy.Request;
type ElasticsearchPlugin = Legacy.Plugins.elasticsearch.Plugin;
type ResponseToolkit = Legacy.ResponseToolkit;

export default class ManagedIndexService {
  esDriver: ElasticsearchPlugin;

  constructor(esDriver: ElasticsearchPlugin) {
    this.esDriver = esDriver;
  }

  // TODO: Not finished, need UI page that uses this first
  getManagedIndex = async (req: Request, h: ResponseToolkit): Promise<ServerResponse<any>> => {
    try {
      const { id } = req.params;
      const params: RequestParams.Get = { id, index: INDEX.OPENDISTRO_ISM_CONFIG };
      const { callWithRequest } = this.esDriver.getCluster(CLUSTER.DATA);
      const results: SearchResponse<any> = await callWithRequest(req, "search", params);
      return { ok: true, response: results };
    } catch (err) {
      console.error("Index Management - ManagedIndexService - getManagedIndex:", err);
      return { ok: false, error: err.message };
    }
  };

  getManagedIndices = async (req: Request, h: ResponseToolkit): Promise<ServerResponse<GetManagedIndicesResponse>> => {
    try {
      const { from, size, search, sortDirection, sortField } = req.query as {
        from: string;
        size: string;
        search: string;
        sortDirection: string;
        sortField: string;
      };

      const managedIndexSorts: ManagedIndicesSort = { index: "managed_index.index", policyId: "managed_index.policy_id" };
      const searchParams: RequestParams.Search = {
        index: INDEX.OPENDISTRO_ISM_CONFIG,
        seq_no_primary_term: true,
        body: {
          size,
          from,
          sort: managedIndexSorts[sortField] ? [{ [managedIndexSorts[sortField]]: sortDirection }] : [],
          query: {
            bool: {
              filter: [{ exists: { field: "managed_index" } }],
              must: getMustQuery("managed_index.name", search),
            },
          },
        },
      };

      const { callWithRequest } = await this.esDriver.getCluster(CLUSTER.DATA);
      const searchResponse: SearchResponse<any> = await callWithRequest(req, "search", searchParams);

      const indices = searchResponse.hits.hits.map((hit) => hit._source.managed_index.index);
      const totalManagedIndices = _.get(searchResponse, "hits.total.value", 0);

      if (!indices.length) {
        return { ok: true, response: { managedIndices: [], totalManagedIndices: 0 } };
      }

      const explainParams = { index: indices.join(",") };
      const { callWithRequest: ismCallWithRequest } = await this.esDriver.getCluster(CLUSTER.ISM);
      const explainResponse: ExplainResponse = await ismCallWithRequest(req, "ism.explain", explainParams);
      const managedIndices = searchResponse.hits.hits.map((hit) => {
        const index = hit._source.managed_index.index;
        return {
          index,
          indexUuid: hit._source.managed_index.index_uuid,
          policyId: hit._source.managed_index.policy_id,
          policySeqNo: hit._source.managed_index.policy_seq_no,
          policyPrimaryTerm: hit._source.managed_index.policy_primary_term,
          policy: hit._source.managed_index.policy,
          enabled: hit._source.managed_index.enabled,
          managedIndexMetaData: transformManagedIndexMetaData(explainResponse[index]), // this will be undefined if we are initializing
        };
      });

      return { ok: true, response: { managedIndices, totalManagedIndices } };
    } catch (err) {
      if (err.statusCode === 404 && err.body.error.type === "index_not_found_exception") {
        return { ok: true, response: { managedIndices: [], totalManagedIndices: 0 } };
      }
      console.error("Index Management - ManagedIndexService - getManagedIndices", err);
      return { ok: false, error: err.message };
    }
  };

  retryManagedIndexPolicy = async (req: Request, h: ResponseToolkit): Promise<ServerResponse<RetryManagedIndexResponse>> => {
    try {
      const { index, state = null } = req.payload as { index: string[]; state?: string };
      const { callWithRequest } = await this.esDriver.getCluster(CLUSTER.ISM);
      const params: RetryParams = { index: index.join(",") };
      if (state) params.body = { state };
      const retryResponse: RetryResponse = await callWithRequest(req, "ism.retry", params);
      return {
        ok: true,
        response: {
          failures: retryResponse.failures,
          updatedIndices: retryResponse.updated_indices,
          // TODO: remove ternary after fixing retry API to return empty array even if no failures
          failedIndices: retryResponse.failed_indices
            ? retryResponse.failed_indices.map((failedIndex) => ({
                indexName: failedIndex.index_name,
                indexUuid: failedIndex.index_uuid,
                reason: failedIndex.reason,
              }))
            : [],
        },
      };
    } catch (err) {
      console.error("Index Management - ManagedIndexService - retryManagedIndexPolicy:", err);
      return { ok: false, error: err.message };
    }
  };

  changePolicy = async (req: Request, h: ResponseToolkit): Promise<ServerResponse<ChangePolicyResponse>> => {
    try {
      const { indices, policyId, include, state } = req.payload as {
        indices: string[];
        policyId: string;
        state: string | null;
        include: { state: string }[];
      };
      const { callWithRequest } = await this.esDriver.getCluster(CLUSTER.ISM);
      const params = { index: indices.join(","), body: { policy_id: policyId, include, state } };
      const changeResponse: RemoveResponse = await callWithRequest(req, "ism.change", params);
      return {
        ok: true,
        response: {
          failures: changeResponse.failures,
          updatedIndices: changeResponse.updated_indices,
          failedIndices: changeResponse.failed_indices.map((failedIndex) => ({
            indexName: failedIndex.index_name,
            indexUuid: failedIndex.index_uuid,
            reason: failedIndex.reason,
          })),
        },
      };
    } catch (err) {
      console.error("Index Management - ManagedIndexService - changePolicy:", err);
      return { ok: false, error: err.message };
    }
  };

  removePolicy = async (req: Request, h: ResponseToolkit): Promise<ServerResponse<RemovePolicyResponse>> => {
    try {
      const { indices } = req.payload as { indices: string[] };
      const { callWithRequest } = await this.esDriver.getCluster(CLUSTER.ISM);
      const params = { index: indices.join(",") };
      const addResponse: RemoveResponse = await callWithRequest(req, "ism.remove", params);
      return {
        ok: true,
        response: {
          failures: addResponse.failures,
          updatedIndices: addResponse.updated_indices,
          failedIndices: addResponse.failed_indices.map((failedIndex) => ({
            indexName: failedIndex.index_name,
            indexUuid: failedIndex.index_uuid,
            reason: failedIndex.reason,
          })),
        },
      };
    } catch (err) {
      console.error("Index Management - ManagedIndexService - removePolicy:", err);
      return { ok: false, error: err.message };
    }
  };
}
