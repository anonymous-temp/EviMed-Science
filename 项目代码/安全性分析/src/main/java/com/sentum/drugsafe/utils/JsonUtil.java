package com.sentum.drugsafe.utils;


import com.alibaba.fastjson.JSONObject;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
public class JsonUtil {


    /**
     * 合并多个JSON对象，每个字段取第一个有数据的值
     * @param jsonObjects JSON对象列表
     * @return 合并后的JSON对象
     */
    public static JSONObject mergeJsonsWithFirstNonEmptyFields(List<JSONObject> jsonObjects) {
        if (jsonObjects == null || jsonObjects.isEmpty()) {
            return new JSONObject();
        }

        JSONObject mergedJson = new JSONObject();

        // 获取所有可能的字段名
        for (JSONObject json : jsonObjects) {
            if (json != null) {
                for (String key : json.keySet()) {
                    // 如果合并结果中还没有这个字段，且当前JSON中该字段有值
                    if (!mergedJson.containsKey(key) && hasValue(json, key)) {
                        mergedJson.put(key, json.get(key));
                    }
                }
            }
        }

        return mergedJson;
    }

    /**
     * 判断JSON对象中指定字段是否有值
     * @param json JSON对象
     * @param key 字段名
     * @return 是否有值
     */
    private static boolean hasValue(JSONObject json, String key) {
        if (!json.containsKey(key)) {
            return false;
        }

        Object value = json.get(key);
        if (value == null) {
            return false;
        }

        // 处理不同类型的值
        if (value instanceof String) {
            return !((String) value).trim().isEmpty();
        } else if (value instanceof List) {
            return !((List<?>) value).isEmpty();
        } else if (value instanceof JSONObject) {
            return !((JSONObject) value).isEmpty();
        }

        return true;
    }

    public static int countNonEmptyFields(JsonNode node) {
        int count = 0;
        if (node.isObject()) {
            Iterable<String> iterable = () -> node.fieldNames();
            for (String fieldName : iterable) {
                JsonNode fieldValue = node.get(fieldName);
                if (fieldValue != null && !fieldValue.isNull()) {
                    if (fieldValue.isArray()) {
                        if (fieldValue.size() > 0) {
                            count++;
                        }
                    } else if (!fieldValue.asText().trim().isEmpty()) {
                        count++;
                    }
                }
            }
        }
        return count;
    }
}
