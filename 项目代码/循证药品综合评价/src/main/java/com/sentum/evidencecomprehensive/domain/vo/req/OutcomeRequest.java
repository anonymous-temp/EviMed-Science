package com.sentum.evidencecomprehensive.domain.vo.req;

import com.sentum.evidencecomprehensive.domain.dto.Disease;
import com.sentum.evidencecomprehensive.domain.dto.Drug;
import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;

/**
 * 结局指标检索的dto类
 * @author zgm
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
@ApiModel(value = "OutcomeRequest", description = "结局指标检索的dto类")
public class OutcomeRequest {
    @ApiModelProperty("药品信息")
    private List<Drug> drugs;
    @ApiModelProperty("疾病信息")
    private List<Disease> diseases;
    @ApiModelProperty("是否需要翻译 1翻译 2不翻译")
    private Integer isTranslate;
    @ApiModelProperty("每页大小，默认10")
    private Integer pageSize;
    @ApiModelProperty("当前页，默认1")
    private Integer pageNum;
    @ApiModelProperty("用户输入框输入条件，进行二次检索")
    private String search;
}
