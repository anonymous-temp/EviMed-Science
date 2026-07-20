package com.sentum.enums;

import lombok.Getter;

@Getter
public enum TraditionalPromptEnum {



    //不良反应分级
      ADVERSEREACTION_RATING("adverseReactionRating","不良反应评分","根据提供的不良反应信息：###${adverseReaction}###，并依据以下规则进行打分：\n" +
              "5分 轻度（症状轻微），无需治疗)CTCAE1级\n" +
              "4分 中度(症状明显，需要干预)CTCAE2级\n" +
              "3分 重度(症状严重，不会立刻危及生命)CTCAE3级\n" +
              "2重度(症状严重，危及生命，紧急治疗)CTCAE4级\n" +
              "1重度(症状严重，死亡)CTCAE5级\n" +
            "说明书暂无相关内容得满分"),
    //特殊人群-儿童
    SPECIAL_CROWD_CHILDREN("specialCrowd_children","特殊人群-儿童","根据提供的儿童用药信息：###${childrenMedicine}###，并依据以下规则进行打分：\n" +
            "1分 儿童可用\n" +
            "0分 儿童不可用\n" +
            "注意：当提供的信息中未出现“禁用”、“忌用”、“不能用”等不能用于儿童的字眼时，请视为儿童可用，给1分。" +
            "说明书暂无相关内容得满分"),
    //特殊人群-孕妇
    SPECIAL_CROWD_PREGNANT_WOMEN("specialCrowd_pregnantWomen","特殊人群-孕妇","根据提供的孕妇及哺乳期妇女用药信息:###${pregnantWomen}###，并依据以下规则进行打分：\n" +
            "1分 孕妇及哺乳期妇女可用\n" +
            "0分 孕妇及哺乳期妇女不可用\n" +
            "注意：当提供的信息中未出现“禁用”、“忌用”、“不能用”等不能用于孕妇及哺乳期妇女的字眼时，请视为孕妇及哺乳期妇女可用，给1分。" +
            "说明书暂无相关内容得满分"),
    //特殊人群-老年
    SPECIAL_CROWD_GERIATRIC("specialCrowd_geriatric","特殊人群-老年","根据提供的老年用药信息:###${geriatricMedicine}###，并依据以下规则进行打分：\n" +
            "1分 老年可用\n" +
            "0分 老年不可用\n" +
            "注意：当提供的信息中未出现“禁用”、“忌用”、“不能用”等不能用于老年的字眼时，请视为老年可用，给1分。" +
            "说明书暂无相关内容得满分"),
    //特殊人群—肝功能
    SPECIAL_CROWD_LIVER("specialCrowd_liver","特殊人群-肝功能","根据提供的肝功能异常患者的用药信息：${doseAdjustmentPatientsWithLiverDysfunction}，并依据以下规则进行打分：\n" +
            "1分 肝功能异常可用\n" +
            "0分 肝功能异常不可用\n" +
            "注意：当提供的信息中未出现“禁用”、“忌用”、“不能用”等不能用于肝功能异常者的字眼时，请视为肝功能异常者可用，给1分。" +
            "说明书暂无相关内容得满分"),
    //肾功能
    SPECIAL_CROWD_RENKONG("specialCrowd_renkong","特殊人群-肾功能","根据提供的肾功能异常患者的用药信息：${doseAdjustmentPatientsWithRenalInsufficiency}，并依据以下规则进行打分：\n" +
            "1 分 肾功能异常可用\n" +
            "0 分 肾功能异常不可用\n" +
            "注意：当提供的信息中未出现“禁用”、“忌用”、“不能用”等不能用于肾功能异常者的字眼时，请视为肾功能异常者可用，给1分。" +
            "说明书暂无相关内容得满分"),
    //安全性评价
    SAFETY_EVALUATION("safetyEvaluation","安全性评价","安全性方面最高5分，暂无相关内容得满分：内容：###${safety}###" +
            "具体评分：5分 开展上市后安全性再评价\n" +
            "3分 开展药品非临床安全性评价\n" +
            "1分 未开展相关研究\n"),

   //药物组成
    DRUG_COMPOSITION("drugComposition","药物组成","根据提供的药物组成信息：###${ingredient}###，并依据以下规则进行打分（多选，每符合一项得一分，最高2分）：\n" +
            "1分 含有毒性成分，不宜用中药饮片代替(有毒，并且不能代替才得分)\n" +
            "1分 含中药单体或提取物\n" +
           "注意:中药单体：中药单体是指从中药材中分离出来的单一、纯净的有效成分。这些成分具有明确的化学结构和性质，是中药材中发挥药效的关键部分。（如：青蒿素）\n" +
           "\n" +
           "中药提取物：中药提取物是指通过特定的工艺方法，从中药材中提取得到的含有多种有效成分的混合物。这些混合物中包含了中药材的多种活性成分，具有多种药理作用。（如：人参提取物）"),
    //现代研究-药理作用
    MODERN_RESEARCH_PHARMACOLOGY("modernResearch_pharmacology","现代研究-药理作用","根据提供的药效信息：###${pharmacology}###，并依据以下规则进行打分：\n" +
            "1分 药理作用明确\n" +
            "0分 药理作用不明确\n" ),

    //指纹图谱研究
    MODERN_RESEARCH_FINGERPRINT("modernResearch_fingerprint","指纹图谱研究","对指纹图谱打分内容:###${fingerprint}##,最高1分  有开展指纹图谱研究得1分（若出现书名号文献标题，则直接满分）"),

    //现代研究-有效性
    MODERN_RESEARCH_EFFECTIVENESS("modernResearch_effectiveness","现代研究-有效性","内容：###${validity}###有效性:，最高1分 有效性明确得1分（若出现书名号文献标题，则直接满分）"),

    //现代研究-含量测定法
    MODERN_RESEARCH_CONTENT_DETECTION("modernResearch_contentDetection","现代研究-含量测定法","含量测定方法:###{content}###打分，最高1分 有建立含量测定方法得1分（若出现书名号文献标题，则直接满分）"),

    //贮存
    STORAGE("storage","贮存","常温、阴凉、冷藏的定义如下：     温度值在8.001-20℃时，视为阴凉处。                     2-8℃视为冷藏。 \n" +
            "温度值在10-30℃时或者未提到温度，视为常温。\n" +
            "根据提供的药品贮藏信息###${storage}###，依据以下规则进行打分（单选）：\n" +
            "3分 常温贮藏\n" +
            "2.5分 常温贮藏，避光或遮光\n" +
            "2分 阴凉贮藏\n" +
            "1.5分 阴凉贮藏，避光或遮光\n" +
            "1分 冷藏贮藏\n"),
    //有效期
    VALIDITY("validity","有效期","根据提供的药品有效期信息：###${indate}###，并依据以下规则进行打分：\n" +
            "3分 大于等于36个月\n" +
            "2分 大于等于24个月小于36个月\n" +
            "1分 小于24个月\n"),

    //药物选择
    DRUG_CHOICE("drugChoice","药物选择","对药品${drugName}药物选择方面进行打分，相关证据：${drugChoice}最高5分" +
            "5分 针对危急重症或重大公共卫生事件有突出优势\n" +
            "3分 疗效确切，临床需要\n" +
            "1分 疗效一般，可用中药饮片替代  最低1分,返回一个得分（必须是一个阿拉伯数字，其他的东西不要）"),

    //说明书-主治功能
    INSTRUCTION_ATTRIBUTE("instructionAttribute","主治功能","根据提供的说明书信息：###${indications}###，并依据以下规则进行打分：\n" +
            "2分 功能主治采用中、西医术语两种方式混合表述(宽松评价，一般有数据（有中医症状和西医症状就可以）)\n" +
            "0分 功能主治未采用中、西医术语两种方式混合表述"),

    //说明书-性状
    INSTRUCTION_ADVERSE_REACTION("instructionAdverseReaction","性状","根据提供的说明书信息：###${description}###，并依据以下规则进行打分：\n" +
            "1分 对气味、外形等性状描述清晰\n" +
            "0分 对气味、外形等性状描述不清晰"),

    //专利、奖金或专项
    PATENT("patent","专利、奖金或专项","根据提供的说明书信息：###${patent}###，并依据以下规则进行打分：\n" +
            "2分 涉及专利、奖金或专项\n" +
            "0分 不涉及专利、奖金或专项"),

    MANUFACTURERS("show_manufacturers","生产企业","根据提供的生产企业信息：###${manufacturers}###，并依据以下规则进行打分(优先高分)：" +
            "3分 生产企业在工信部医药工业百强榜" +
            "2分 生产企业在中国中药企业 TOP100 排行榜" +
            "1分 其他企业" +
            "\n" ),

    //禁忌症
    CONTRAINDICATIONS("contraindications","禁忌","根据提供的说明书信息：###${contraindications}###，并依据以下规则进行打分：\n" +
            "1分 无内容，或者禁忌症不良反应明确\n" +
            "0分 存在尚不明确的信息"),



    //安全性评价
    SHOW_SAFETY_EVALUATION("show_safetyEvaluation","安全性评价","你作为一名专业临床医生，请描述下${drugName}在安全性方面有哪些研究？"),

    //古代经典名方目录
    SHOW_CLASSIC("show_classic","古代经典名方目录","请帮我找出以下药品的古代经典名方信息：${drugName}"),

    //指纹图谱信息
    SHOW_FINGERPRINT("show_fingerprint","指纹图谱信息","请帮我找出以下药品的指纹图谱信息：${drugName}"),
    SHOW_FINGERPRINTx("show_fingerprint","指纹图谱信息","总结说明药品${drugName}的指纹图谱相关的文献信息,文献信息：${}，返回为格式为文献标题：总结信息，必要的换行用$$表示        "),

    //有效性评价
    SHOW_VALIDITY_EVALUATION("show_validityEvaluation","有效性评价","${drugName}上市后进行了哪些有效性再评价相关研究？"),
    SHOW_VALIDITY_EVALUATIONx("show_validityEvaluation","有效性评价","总结说明药品${drugName}的有效性相关的文献信息,文献信息：${}，返回为格式为文献标题：总结信息，必要的换行用$$表示        "),

    //含量测定方法
    SHOW_CONTENT_DETECTION("show_contentDetection","含量测定方法","请帮我找出以下药品的含量测定方法：${drugName}"),
    SHOW_CONTENT_DETECTIONx("show_contentDetection","含量测定方法","总结说明药品${drugName}的含量测定方法相关的文献信息,文献信息：${}，返回为格式为文献标题：总结信息，必要的换行用$$表示        "),

    //专利、所获奖项
    SHOW_PATENT("show_patent","专利、奖金或专项","${drugName}获得过哪些专利、奖项或专项，请分别进行描述，专利最好能提供专利号"),

    //企业状况
    SHOW_MANUFACTURERS("show_manufacturers","企业状况","请根据知识库分析${manufacturer}的生产企业状况，该企业在制药企业和工信部医药工业百强榜企业中的排名情况"),

    //药物选择
    SHOW_DRUG_CHOICE("show_drugChoice","药物选择","${drugName}针对危急重症或重大公共卫生事件有突出优势有哪些。${drugName}在临床中疗效如何，是否为临床必须药品？在临床中还是有可以替代${drugName}的中药饮片？"),


    //禁忌症
    SHOW_DRUG_CONTRAINDICATIONS("contraindications","禁忌","请列出药品${drugName}的禁忌证、不良反应，如果没有则返回暂无相关内容，尽量不要出现生不明确（如果有但不明确则返回生不明确）"),













        ;

        private String key;

        private String describe;

        private String defaultPrompt;



    TraditionalPromptEnum (String key,String describe,String defaultPrompt){
            this.describe = describe;
            this.key = key;
            this.defaultPrompt = defaultPrompt;

        }
        public static  String TraditionalPromptEnum(String key){
            com.sentum.enums.PromptEnum[] values = com.sentum.enums.PromptEnum.values();
            for(com.sentum.enums.PromptEnum value :values){
                if(value.getKey().equals(key)){
                    return value.getDescribe();
                }
            }
            return "";
        }

    }


