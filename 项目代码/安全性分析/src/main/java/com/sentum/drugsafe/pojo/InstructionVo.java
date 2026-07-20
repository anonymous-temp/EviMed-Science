package com.sentum.drugsafe.pojo;

import lombok.Data;

import java.util.ArrayList;
import java.util.List;

@Data
public class InstructionVo {

    /**
     * 警告
     */
    private List<DrugContent> warnings ;

    /**
     * 不良反应
     */
    private List<DrugContent> adverseReactions ;

    /**
     * 禁忌症
     */
    private List<DrugContent> contraindications ;

    /**
     * 注意事项
     */
    private List<DrugContent> precautions ;

    private String drugName;

    public InstructionVo(){
        warnings = new ArrayList<>();
        adverseReactions = new ArrayList<>();
        contraindications = new ArrayList<>();
        precautions = new ArrayList<>();
        drugName = "";
    }
}
