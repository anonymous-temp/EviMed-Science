package com.sentum.service.impl;

import com.alibaba.fastjson.JSONArray;
import com.alibaba.fastjson.JSONObject;
import com.google.common.collect.Maps;
import com.sentum.service.InstructionSearch;
import com.sentum.util.HttpClientUtils;
import lombok.extern.slf4j.Slf4j;
import org.apache.commons.codec.digest.DigestUtils;
import org.apache.http.client.methods.CloseableHttpResponse;
import org.apache.http.client.methods.HttpGet;
import org.apache.http.impl.client.CloseableHttpClient;
import org.apache.http.impl.client.HttpClients;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.util.HashMap;
import java.util.Map;

@Service
@Slf4j
@Deprecated
public class InstructionSearchImpl implements InstructionSearch {

    public final static String URL = "https://api.dxy.cn/open/medical/open.drug.instructions.detail";
    public final static String AppId = System.getenv("EVIMED_INSTRUCTION_APP_ID");
    public final static String SecretKey = System.getenv("EVIMED_INSTRUCTION_SECRET_KEY");
    @Override
    public JSONObject getInstruction(String str) {

        Long TimeStamp = System.currentTimeMillis();
        Integer Nonce = 123456; //使用随机六位数字
        String Token = getToken(AppId,SecretKey,String.valueOf(Nonce),String.valueOf(TimeStamp));
        String url = URL; //接口地址
        HashMap<String, String> headerHashMap = new HashMap<>();
        headerHashMap.put("Token", Token);
        headerHashMap.put("TimeStamp", String.valueOf(TimeStamp));
        headerHashMap.put("AppId", AppId);
        headerHashMap.put("Nonce", String.valueOf(Nonce));

        HashMap<String, String> map = new HashMap<>();
        map.put("searchType", "2");
        map.put("searchContent", str);

        String s = HttpClientUtils.get(url, headerHashMap, map);

        log.info("请求结果：{}",s);
        if (s != null) {
            JSONObject jsonObject = JSONObject.parseObject(s);
             return jsonObject.getJSONObject("result");
        }
        return null;
    }





    protected static final String getToken(String AppId, String SecretKey, String Nonce, String TimeStamp) {
        return  DigestUtils.md5Hex(AppId.concat(Nonce).concat(TimeStamp).concat(SecretKey)).toLowerCase();
    }
}
