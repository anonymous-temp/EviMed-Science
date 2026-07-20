package com.sentum.util;

import com.alibaba.fastjson.JSONObject;
import com.sentum.pojo.DrugInfoNew;
import com.sentum.service.LxGptService;
import lombok.Data;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

@Data
public class BatchGetGpt {

    private Map<String, String> promptList;

    private DrugInfoNew drugInfoNew;


    private LxGptService lxGptService;

    public BatchGetGpt(Map<String, String> promptList, LxGptService lxGptService) {
        this.promptList = promptList;
        this.lxGptService = lxGptService;
    }


    public Map<String, String> execute() {
        HashMap<String, String> Mapx = new HashMap<>();
        AtomicInteger x = new AtomicInteger(1);
        HashMap<String, String> promptR = new HashMap<>();
        StringBuilder stringBuilder = new StringBuilder();
        stringBuilder.append("请根据资料说明书资料***********"+drugInfoNew+"***********以下提示，分析以下这些问题（不同序号问题之间没有关联性，但问题标号与返回字段需要一一对应）（答案要在每个字段中去找，相关的就整理出来）：\n");
        promptList.forEach((k, v) -> {
            String key = "question" + x;
            String prompt = "###"+key + "：###" + v + "回答时请不要带标题’问题几‘的字样(返回json对应"+key+"字段)\n";
            stringBuilder.append(prompt);
            String title = "question" + x;
            promptR.put(title, "对应###" + key + "###的答案(对应每个问题标题，必须一一对应)");
            Mapx.put(k, title);
            x.incrementAndGet();

        });
        JSONObject responseFormat = getResponseFormat(promptR);

        JSONObject jsonObject = lxGptService.executeGptPlus(stringBuilder.toString(), "检索所有项目", responseFormat, "","");
        HashMap<String, String> stringStringHashMap = new HashMap<>();
        for (Map.Entry<String, String> entry : promptList.entrySet()) {
            String key = entry.getKey();
            String value = entry.getValue();
            String title = Mapx.get(key);
            String s = jsonObject.getString(title).replaceAll("\\$\\$", "\n");
            stringStringHashMap.put(key, s);
        }
        return stringStringHashMap;
    }


    private JSONObject getResponseFormat(Map<String, String> format) {
        JSONObject responseFormat = new JSONObject();
        JSONObject json_schema = new JSONObject();
        JSONObject schema = new JSONObject();
        JSONObject properties = new JSONObject();
        responseFormat.put("type", "json_schema");   //gpt未说明   固定
        responseFormat.put("json_schema", json_schema);  //gpt未说明   固定
        json_schema.put("name", "reasoning_schema");   //gpt未说明   固定
        json_schema.put("strict", true);  //开启固定格式

        schema.put("additionalProperties", false);
        ArrayList<String> strings = new ArrayList<>();//此对象包含的字段
        format.forEach((k, v) -> {                  //组装此对象的所有字段
            JSONObject propertie = new JSONObject();
            propertie.put("type", "string");   //这里默认认为字符串类型
            propertie.put("description", v);   // 此字段的描述
            properties.put(k, propertie);   // 此字段作为json的key，对应值为
            strings.add(k);
        });
        schema.put("properties", properties);
        schema.put("required", strings);  //此对象包含的字段
        schema.put("type", "object");
        json_schema.put("schema", schema);
        return responseFormat;

    }




}
