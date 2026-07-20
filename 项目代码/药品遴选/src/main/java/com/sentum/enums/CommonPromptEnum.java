package com.sentum.enums;

import lombok.Getter;

@Getter
public enum CommonPromptEnum {

    DISEASE_SPLIT("diseaseSplit", "疾病分词", "角色:你是一位医学专家\n" +
            "任务示例:\n" +
            "充血性心力衰竭    输出:心力衰竭\n" +
            "反流性食管炎    输出:食管炎\n" +
            " 单纯局部癫痫发作,复杂性局部癫痫发作,原发性全身性强直阵挛性癫痫发作    输出:癫痫\n" +
            "原发性高血压    输出:高血压\n" +
            "成人费城染色体阳性急性淋巴细胞白血病 输出:白血病" +
            "要求:\n" +
            "（1）子宫内膜炎、大肠湿热    不应该将“子宫”或“大肠”去掉，这种不能算作定语\n" +
            "（2）细菌性鼻窦炎  应该去掉“细菌性”，属于定语\n" +
            "（3）白带量多  不应该去掉“量多”。\n" +
            "（4）高胆固醇血症、高甘油三酯血症、“高尿酸血症”，是一个疾病，“高”不是定语，不能拆分\n" +
            "（5）胃癌、肺癌不能变成“癌”，癌的范围太大了，应该保留癌症的类型\n" +
            "（6）胃肠道间质瘤，是一个病，不能将“胃肠道”去掉\n" +
            "（7）2型糖尿病、1型糖尿病不拆分；而成人2型糖尿病，可以简化为“2型糖尿病”\n" +
            "（8）“冠状动脉粥样硬化性心脏病”是一个整体的疾病名称，不用拆分\n" +
            "（9）对于感染与炎症类型的疾病症状，需要去掉定语并精确到具体的感染或炎症，对于”细菌性“，”慢性“，”急性“等定性词语皆为定语。如“细菌性心内膜炎”，变成“心内膜炎”;而“呼吸道感染伴粘稠痰液”需整个保留。\n" +
            "（10）只输出去除定语后的列表结果，不要输出解释性的信息。\n" +
            "以下是你需要处理的数据:");


    private String key;

    private String describe;

    private String defaultPrompt;


    CommonPromptEnum(String key, String describe, String defaultPrompt) {
        this.describe = describe;
        this.key = key;
        this.defaultPrompt = defaultPrompt;

    }

    public static String PromptEnum(String key) {
        com.sentum.enums.CommonPromptEnum[] values = com.sentum.enums.CommonPromptEnum.values();
        for (com.sentum.enums.CommonPromptEnum value : values) {
            if (value.getKey().equals(key)) {
                return value.getDefaultPrompt();
            }
        }
        return "";
    }
}
