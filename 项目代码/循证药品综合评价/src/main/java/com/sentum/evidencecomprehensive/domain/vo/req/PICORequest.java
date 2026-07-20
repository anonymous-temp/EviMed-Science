package com.sentum.evidencecomprehensive.domain.vo.req;

import com.fasterxml.jackson.annotation.JsonIgnore;
import com.sentum.evidencecomprehensive.domain.dto.WordStatus;
import io.swagger.annotations.ApiModelProperty;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.ArrayList;
import java.util.List;

/**
 * Description:
 * DateTime: 2025/2/27
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
public class PICORequest {
    @ApiModelProperty("用户输入条件")
    private String word;
    @ApiModelProperty("用户输入条件的中文")
    private String zhWord;
    @ApiModelProperty("用户输入条件的英文")
    private String enWord;
    @ApiModelProperty("中文同义词")
    private List<WordStatus> zhSynonym = new ArrayList<>();
    @JsonIgnore
    private List<WordStatus> enSynonym = new ArrayList<>();
    @JsonIgnore
    private List<WordStatus> otherSynonym = new ArrayList<>();
    @JsonIgnore
    private String name = "";
    @JsonIgnore
    private String expandSynonym;
    @JsonIgnore
    private String dosageForm = "";
    @JsonIgnore
    private String commodityName = "";
    @ApiModelProperty("当前节点的数据关系，用户输入条件1，与2，非3")
    private Integer status;
    @JsonIgnore
    private List<String> commodityNames;
    @JsonIgnore
    private List<String> zhDrugNames;
    @JsonIgnore
    private List<String> enDrugNames;

    //##################### p ###################
    @JsonIgnore
    private Integer type = 1;
}
