package com.sentum.pojo.vo;

import lombok.Data;

import java.util.List;

@Data
public class DrugDisSdy {

    private String title;

    private String drugName;

    private String drugId;

    private String disease;

    private String adverseReaction;

    private String safeAdvantage;

    private String treatmentAdvantage;

    private String component;

    private List<GuidelinesVo> guide;
}
