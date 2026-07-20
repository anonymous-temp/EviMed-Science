package com.sentum.enums;

import lombok.Getter;

@Getter
public enum GptDemoEnum {

    GPT_DEMO_1("GPT_DEMO_1", "作为一个医学工作者，我需要你根据我给出的药品信息以及打分规则进行打分返回json格式数据" +
            "json数据包含字段为：content（String类型）和Score（数字或小数类型）\n" +
            "具体格式如下(只是举例，需要满足下列回答格式，回答内容请对应给出的具体问题以及资料)：\n" +
            "回答：{\"content\":\"打分的相关依据\",\"score\":\"分数\"}；严格按照上述格式返回"),

    ;
    private String name;
    private String content;
    GptDemoEnum(String name, String content) {
        this.name = name;
        this.content = content;
    }
}
