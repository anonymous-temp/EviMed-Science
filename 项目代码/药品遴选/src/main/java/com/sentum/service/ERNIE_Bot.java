package com.sentum.service;

import cn.hutool.http.HttpUtil;
import com.alibaba.fastjson.JSONObject;
import com.sentum.util.RedisUtil;
import okhttp3.*;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.TimeUnit;

@Component
public class ERNIE_Bot {
    final static String  ERNIE_ACCESS_TOKEN = "ernine_access_token";
    public  String chat(String msg) throws IOException {
        Map<String,Object> map = new HashMap<>();
        Object token = RedisUtil.redis.opsForValue().get(ERNIE_ACCESS_TOKEN);
        String accessToken;
        if(token!=null){
            accessToken = token.toString();
        }else {
            accessToken = getAccessToken();
        }
        Map<String,Object> content = new HashMap<>();
        content.put("role","user");
        content.put("content",msg);
        map.put("messages", Collections.singletonList(content));
//        String res = HttpUtil.post("https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop/chat/eb-instant?access_token="+accessToken, JSONObject.toJSONString(map));
        String res = HttpUtil.post("https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop/chat/completions_pro?access_token="+accessToken, JSONObject.toJSONString(map));
        return JSONObject.parseObject(res).getString("result").replaceAll("\\\\n","");
    }

    public static void main(String[] args) {
        String s = "json{    \"liverScore\": 1,    \"kidneyScore\": 1,    \"process\": \"对于阿司匹林肠溶片在肝功能异常患者中的使用情况分析如下：\\n1. 药品说明书中未明确提及“肝功能”相关词语，但根据常规用药指导，非甾体抗炎药在肝功能不全患者中需谨慎使用，因其可能增加肝脏负担。然而，缺乏具体数据来明确阿司匹林在何种程度的肝功能异常下不可用或需要调整剂量。\\n2. 在缺乏具体数据的情况下，我们倾向于给一个保守的评分。由于非甾体抗炎药通常在中度肝功能异常下仍可使用但可能需要监控，我们认为阿司匹林肠溶片在中度肝功能异常时可用，因此给出1分。这同样适用于轻度肝功能异常。\\n3. 对于重度肝功能异常，由于药物代谢和排泄可能受到显著影响，增加了潜在风险，但说明书未明确提及禁用，因此我们仍然保持1分的评分。\\n\\n对于阿司匹林肠溶片在肾功能异常患者中的使用情况分析如下：\\n1. 药品说明书中未明确提及“肾功能”相关词语。但类似于肝功能异常的情况，非甾体抗炎药在肾功能不全患者中也需要谨慎使用。\\n2. 考虑到阿司匹林主要通过肾脏排泄，肾功能不全可能影响其清除率。然而，由于说明书未提供具体的使用限制或剂量调整建议，我们同样给出一个保守的评分。\\n3. 我们认为在中度肾功能异常时，阿司匹林肠溶片可用但需要监控，因此给出1分。这一评分同样适用于轻度肾功能异常。\\n4. 对于重度肾功能异常，尽管潜在风险增加，但说明书未明确提及禁用，所以评分保持不变为1分。\\n\\n综上所述，根据提供的评分规则和分析过程，肝功能异常者和肾功能异常者的得分均为1分。\"}";
        String s1 = s.replaceAll("\\\\n", "");
        System.out.println(s1);
    }
    private  String  getAccessToken() throws IOException {
        final OkHttpClient HTTP_CLIENT = new OkHttpClient().newBuilder().build();
        MediaType mediaType = MediaType.parse("application/json");
        RequestBody body = RequestBody.create(mediaType, "");
        Request request = new Request.Builder()
                .url("https://aip.baidubce.com/oauth/2.0/token?client_id=" + System.getenv("ERNIE_CLIENT_ID")
                    + "&client_secret=" + System.getenv("ERNIE_CLIENT_SECRET")
                    + "&grant_type=client_credentials")
                .method("POST", body)
                .addHeader("Content-Type", "application/json")
                .addHeader("Accept", "application/json")
                .build();
        Response response = HTTP_CLIENT.newCall(request).execute();
        JSONObject jsonObject = JSONObject.parseObject(response.body().string());
        System.out.println(jsonObject.toJSONString());
        RedisUtil.redis.opsForValue().set("ernine_access_token",jsonObject.getString("access_token"),3600, TimeUnit.SECONDS);
        return jsonObject.getString("access_token");
    }
}
