package com.sentum.drugsafe.utils;


import com.alibaba.fastjson.JSONArray;
import com.alibaba.fastjson.JSONObject;

public class JsonKeyToLower {

    public static Object convertKeysToLowerCase(Object obj) {
        if (obj instanceof JSONObject) {
            JSONObject jsonObject = (JSONObject) obj;
            JSONObject newJsonObject = new JSONObject();
            for (String key : jsonObject.keySet()) {
                Object value = jsonObject.get(key);
                newJsonObject.put(key.toLowerCase(), convertKeysToLowerCase(value));
            }
            return newJsonObject;
        } else if (obj instanceof JSONArray) {
            JSONArray jsonArray = (JSONArray) obj;
            JSONArray newJsonArray = new JSONArray();
            for (Object item : jsonArray) {
                newJsonArray.add(convertKeysToLowerCase(item));
            }
            return newJsonArray;
        } else {
            return obj; // 基础类型直接返回
        }
    }


}