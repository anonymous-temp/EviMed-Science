package com.sentum.evidencecomprehensive.domain.vo.req;

import com.sentum.evidencecomprehensive.domain.dto.Drug;
import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;

/**
 * 疾病、参比药物检索的dto类
 * @author zgm
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
@ApiModel(value = "DrugRequest", description = "疾病、参比药物检索的dto类")
public class DrugRequest {
    @ApiModelProperty("药品信息")
    private List<Drug> drugs;
    @ApiModelProperty("是否需要翻译 1翻译 2不翻译，默认1翻译")
    private Integer isTranslate = 1;
    @ApiModelProperty("每页大小，默认10")
    private Integer pageSize = 10;
    @ApiModelProperty("当前页，默认1")
    private Integer pageNum = 1;
    @ApiModelProperty("用户输入框输入条件，进行二次检索")
    private String search = "";
}
